import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { auth, createSessionToken, SESSION_COOKIE, sessionMiddleware } from "../src/auth";
import { CaptureError, type Deps, type SaveRequest } from "../src/deps";
import { excerptOf } from "../src/store";
import type { AppEnv, Env, SaveRecord } from "../src/types";
import { createWeb, notFound } from "../src/web";
import { memoryStore } from "./memory-store";

const testEnv: Env = {
  PUBLIC_URL: "https://xposts.test",
  REPO_URL: "https://github.com/example/xposts",
  X_BOT_HANDLE: "SaveXPosts",
  SESSION_SECRET: "a-long-random-secret-for-tests-only",
};

const store = memoryStore();
const requests: SaveRequest[] = [];
let nextError: CaptureError | null = null;

const deps: Deps = {
  store,
  async save(request) {
    requests.push(request);
    if (nextError) throw nextError;
    return seed(request.post.handle ?? "ada", request.post.id);
  },
};

const app = new Hono<AppEnv>();
app.use("*", sessionMiddleware);
app.route("/", auth);
app.route("/", createWeb(deps));
app.notFound(notFound);

const call = (path: string, init?: RequestInit) => app.request(path, init, testEnv);

async function signedIn() {
  const token = await createSessionToken(testEnv, { sub: "auth0|ada", name: "Ada" });
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

const TEXT = "Hello <script>alert(1)</script> world\nsecond line, the whole text";
const encoder = new TextEncoder();

async function seed(handle: string, postId: string, options: { xApi?: boolean; record?: boolean; warnings?: string[] } = {}) {
  const record: SaveRecord = {
    schema: "xposts/save/v1",
    postId,
    url: `https://x.com/${handle}/status/${postId}`,
    capturedAt: "2026-11-16T10:00:05.000Z",
    post: { handle, authorName: "Ada <b>Lovelace</b>", text: TEXT, postedAt: "2026-11-15T09:00:00.000Z" },
    renderer: { package: "@xeet/core", version: "0.1.0", upstream: "1", options: {} },
    text: { source: "x-api", sourcesMatch: null },
    fingerprint: { snowflakeTime: null, apiCreatedAt: null, timeConsistent: null, editHistory: null, apiHeaders: {}, pageAppVersion: null },
    files: { png: "a".repeat(64), xeetInput: "c".repeat(64), ...(options.xApi ? { xApi: "d".repeat(64) } : {}) },
    warnings: options.warnings ?? [],
  };
  return store.createSave(
    {
      username: handle.toLowerCase(),
      postId,
      handle,
      authorName: "Ada <b>Lovelace</b>",
      excerpt: excerptOf(TEXT),
      postedAt: record.post.postedAt,
      capturedAt: record.capturedAt,
      pngSha256: "a".repeat(64),
      recordSha256: "b".repeat(64),
      width: 600,
      height: 300,
      source: "web",
    },
    {
      png: encoder.encode("png"),
      // An empty record stands for a missing one: readRecord cannot parse it.
      record: options.record === false ? new Uint8Array() : encoder.encode(JSON.stringify(record)),
      xeetInput: encoder.encode("{}"),
      ...(options.xApi ? { xApi: encoder.encode("{}") } : {}),
    },
  );
}

beforeEach(() => {
  store.saves.length = 0;
  requests.length = 0;
  nextError = null;
});

describe("home", () => {
  it("invites sign-in when signed out and shows the latest saves as blob thumbnails", async () => {
    const { save } = await seed("Ada", "100");
    const html = await (await call("/")).text();
    expect(html).toContain("Sign in to save a post");
    expect(html).toContain("@SaveXPosts");
    expect(html).toContain(`src="${save.blob.url}"`);
    expect(html).toContain('href="/ada/100"');
    expect(html).toContain("@Ada");
    expect(html).not.toContain("<script>alert(1)");
  });

  it("shows the form when signed in", async () => {
    const html = await (await call("/", { headers: await signedIn() })).text();
    expect(html).toContain('action="/submit"');
    expect(html).toContain("Ada");
    expect(html).toContain("/auth/logout");
    expect(html).toContain("Nothing has been saved yet");
  });
});

describe("POST /submit", () => {
  const form = (url: string, headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ url }),
  });
  const post = async (url: string) => call("/submit", form(url, { ...(await signedIn()), origin: "https://xposts.test" }));

  it("sends signed-out visitors to sign in", async () => {
    const response = await call("/submit", form("https://x.com/ada/status/100", { origin: "https://xposts.test" }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/auth/login");
    expect(requests).toHaveLength(0);
  });

  it("refuses a request from another origin, or with none", async () => {
    const session = await signedIn();
    const wrong = await call("/submit", form("https://x.com/ada/status/100", { ...session, origin: "https://evil.test" }));
    expect(wrong.status).toBe(403);
    expect((await call("/submit", form("https://x.com/ada/status/100", session))).status).toBe(403);
    expect(requests).toHaveLength(0);
  });

  it("re-shows the form with an error for a URL that is not a post", async () => {
    const response = await post("https://example.com/<b>");
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("not a link to a post");
    expect(html).toContain("https://example.com/&lt;b&gt;");
    expect(requests).toHaveLength(0);
  });

  it("saves the post and redirects to its page", async () => {
    const response = await post("https://x.com/Ada/status/2122184794209714368?s=20");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/ada/2122184794209714368");
    expect(requests).toEqual([{ post: { id: "2122184794209714368", handle: "Ada" }, source: "web", requestedBy: "auth0|ada" }]);
  });

  it("re-shows the form with the message of a retryable failure as 502", async () => {
    nextError = new CaptureError("X is busy <try later>", true);
    const response = await post("https://x.com/ada/status/100");
    expect(response.status).toBe(502);
    const html = await response.text();
    expect(html).toContain("X is busy &lt;try later&gt;");
    expect(html).toContain('value="https://x.com/ada/status/100"');
  });

  it("answers 422 for a failure that retrying cannot fix", async () => {
    nextError = new CaptureError("The post was deleted", false);
    const response = await post("https://x.com/ada/status/100");
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("The post was deleted");
  });
});

describe("static pages", () => {
  it("about states the proof and its limits", async () => {
    const html = await (await call("/about")).text();
    expect(html).toContain("does <strong>not</strong> prove");
    expect(html).toContain("curl -I");
    expect(html).toContain("Last-Modified");
    expect(html).toContain(testEnv.REPO_URL);
    expect(html).not.toMatch(/algorand/i);
  });

  it("verify page loads", async () => {
    const response = await call("/verify");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/api/verify/");
  });

  it("unknown paths are 404", async () => {
    const response = await call("/a/b/c/d");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Not found");
  });
});

describe("/s/:username/:status", () => {
  it("redirects permanently to the image blob, whatever the case of the handle", async () => {
    const { save } = await seed("Ada", "100");
    for (const path of ["/s/ada/100", "/s/ADA/100"]) {
      const response = await call(path);
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe(save.blob.url);
    }
  });

  it("is 404 when the post is not saved or the reference is malformed", async () => {
    expect((await call("/s/ada/100")).status).toBe(404);
    expect((await call("/s/ada/abc")).status).toBe(404);
    expect((await call("/s/bad%20handle/100")).status).toBe(404);
  });
});

describe("/:username", () => {
  it("lists the saves of an author, newest post first", async () => {
    await seed("Ada", "100");
    await seed("Ada", "200");
    await seed("bob", "300");
    const response = await call("/ADA");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("@Ada");
    expect(html).toContain("https://x.com/Ada");
    expect(html.indexOf('href="/ada/200"')).toBeLessThan(html.indexOf('href="/ada/100"'));
    expect(html).not.toContain("/bob/300");
  });

  it("shows an empty state, with the form, instead of a 404", async () => {
    const response = await call("/nobody", { headers: await signedIn() });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("No posts by @nobody");
    expect(html).toContain('action="/submit"');
  });

  it("is 404 for an invalid handle", async () => {
    expect((await call("/bad%20handle")).status).toBe(404);
    expect((await call("/this_handle_is_too_long")).status).toBe(404);
  });

  it("never treats a fixed name as a handle", async () => {
    await seed("api", "100");
    await seed("s", "100");
    for (const path of ["/api", "/s", "/auth", "/submit", "/api/100", "/s/100", "/verify/100", "/about/100"]) {
      expect((await call(path)).status, path).toBe(404);
    }
    // The fixed pages still win over handles.
    expect((await call("/about")).status).toBe(200);
    expect((await call("/verify")).status).toBe(200);
  });
});

describe("/:username/:status", () => {
  it("shows the image, the whole text from the record and the proof", async () => {
    const { save } = await seed("Ada", "100", { xApi: true });
    const html = await (await call("/ada/100")).text();
    expect(html).toContain(`src="${save.blob.url}"`);
    expect(html).toContain(`property="og:image" content="${save.blob.url}"`);
    expect(html).toContain("second line, the whole text");
    expect(html).toContain("Hello &lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("Ada &lt;b&gt;Lovelace&lt;/b&gt;");
    expect(html).toContain("https://x.com/Ada/status/100");
    expect(html).toContain("2026-11-15 09:00 UTC");
    expect(html).toContain("2026-11-16 10:00 UTC");
    expect(html).toContain('href="https://xposts.test/s/ada/100"');
    // What Azure states, and the hashes.
    for (const value of [save.blob.url, save.blob.createdOn, save.blob.lastModified, save.blob.contentMd5!, "a".repeat(64), "b".repeat(64)]) {
      expect(html).toContain(value);
    }
    expect(html).toContain(save.blob.etag.replace(/"/g, "&quot;"));
    expect(html).toContain(`curl -I ${save.blob.url}`);
    // Downloads.
    expect(html).toContain(`href="${store.fileUrl(save, "record")}"`);
    expect(html).toContain(`href="${store.fileUrl(save, "xeetInput")}"`);
    expect(html).toContain(`href="${store.fileUrl(save, "xApi")}"`);
  });

  it("lists the X API file only when the record has it", async () => {
    const { save } = await seed("ada", "100");
    const html = await (await call("/ada/100")).text();
    expect(html).toContain(store.fileUrl(save, "xeetInput"));
    expect(html).not.toContain(".x-api.json");
  });

  it("falls back to the excerpt when the record is missing, and shows warnings", async () => {
    await seed("ada", "100", { record: false });
    const html = await (await call("/ada/100")).text();
    expect(html).toContain("Hello &lt;script&gt;alert(1)");
    await seed("ada", "101", { warnings: ["Text sources <differ>"] });
    expect(await (await call("/ada/101")).text()).toContain("Text sources &lt;differ&gt;");
  });

  it("is 404 with the save form prefilled when the post is not saved", async () => {
    const response = await call("/ada/100", { headers: await signedIn() });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('value="https://x.com/ada/status/100"');
  });

  it("redirects to the lower-case path when the handle differs only by case", async () => {
    await seed("Ada", "100");
    const response = await call("/ADA/100");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/ada/100");
  });

  it("is 404 for an invalid id", async () => {
    expect((await call("/ada/abc")).status).toBe(404);
    expect((await call(`/ada/${"1".repeat(21)}`)).status).toBe(404);
  });
});

describe("/:username/status/:status", () => {
  it("redirects an x.com path to the page of the save", async () => {
    const response = await call("/Ada/status/100");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/ada/100");
  });

  it("is 404 for an invalid id or handle", async () => {
    expect((await call("/ada/status/abc")).status).toBe(404);
    expect((await call("/api/status/100")).status).toBe(404);
  });
});
