import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { auth, createSessionToken, SESSION_COOKIE, sessionMiddleware } from "../src/auth";
import { completeCapture, failCapture, getCapture, setAnchor } from "../src/db";
import type { AppEnv, ArchiveJob, Env } from "../src/types";
import { notFound, web } from "../src/web";

const sent: ArchiveJob[] = [];
const testEnv: Env = {
  ...env,
  PUBLIC_URL: "https://xposts.test",
  SESSION_SECRET: "a-long-random-secret-for-tests-only",
  ARCHIVE_QUEUE: { send: async (job: ArchiveJob) => void sent.push(job) } as unknown as Queue<ArchiveJob>,
};

const app = new Hono<AppEnv>();
app.use("*", sessionMiddleware);
app.route("/", auth);
app.route("/", web);
app.notFound(notFound);

const call = (path: string, init?: RequestInit) => app.request(path, init, testEnv);

async function signedIn(extra: Record<string, string> = {}) {
  const token = await createSessionToken(testEnv, { sub: "auth0|ada", name: "Ada" });
  return { cookie: `${SESSION_COOKIE}=${token}`, ...extra };
}

async function insert(postId: string, ts: string, createdAt = "2026-11-16T10:00:00.000Z") {
  await env.DB.prepare("INSERT INTO captures (post_id, ts, source, requested_by, created_at) VALUES (?, ?, 'web', 'x', ?)")
    .bind(postId, ts, createdAt)
    .run();
  return { postId, ts };
}

const done = {
  authorHandle: "ada",
  authorName: "Ada <b>Lovelace</b>",
  text: "Hello <script>alert(1)</script> world",
  postedAt: "2026-11-15T09:00:00.000Z",
  capturedAt: "2026-11-16T10:00:05.000Z",
  pngSha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
  width: 600,
  height: 300,
};

beforeEach(async () => {
  sent.length = 0;
  await env.DB.exec("DELETE FROM captures");
});

describe("pages", () => {
  it("home page invites sign-in when signed out and shows recent captures", async () => {
    const ref = await insert("100", "20261116100000");
    await completeCapture(env.DB, ref, done);
    const html = await (await call("/")).text();
    expect(html).toContain("Sign in to save a post");
    expect(html).toContain("@SaveXPosts");
    expect(html).toContain("/p/100/20261116100000/post.png");
    expect(html).not.toContain("<script>alert(1)");
  });

  it("home page shows the form when signed in", async () => {
    const html = await (await call("/", { headers: await signedIn() })).text();
    expect(html).toContain('action="/submit"');
    expect(html).toContain("Ada");
    expect(html).toContain("/auth/logout");
  });

  it("about, verify and unknown pages", async () => {
    const about = await (await call("/about")).text();
    expect(about).toContain("does <strong>not</strong> prove");
    expect(about).toContain(env.REPO_URL);
    expect((await call("/verify")).status).toBe(200);
    const missing = await call("/nope");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("Not found");
  });

  it("lists the captures of an author", async () => {
    const ref = await insert("100", "20261116100000");
    await completeCapture(env.DB, ref, done);
    expect((await call("/u/ADA")).status).toBe(200);
    expect((await call("/u/nobody")).status).toBe(404);
    expect((await call("/u/bad%20handle")).status).toBe(404);
  });
});

describe("POST /submit", () => {
  const form = (url: string, headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ url }),
  });

  it("sends signed-out visitors to sign in", async () => {
    const response = await call("/submit", form("https://x.com/ada/status/100", { origin: "https://xposts.test" }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/auth/login");
    expect(sent).toHaveLength(0);
  });

  it("refuses a request from another origin, or with none", async () => {
    const session = await signedIn();
    const wrong = await call("/submit", form("https://x.com/ada/status/100", { ...session, origin: "https://evil.test" }));
    expect(wrong.status).toBe(403);
    const none = await call("/submit", form("https://x.com/ada/status/100", session));
    expect(none.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("re-shows the form with an error for a URL that is not a post", async () => {
    const response = await call("/submit", form("https://example.com/<b>", { ...(await signedIn()), origin: "https://xposts.test" }));
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("not a link to a post");
    expect(html).toContain("https://example.com/&lt;b&gt;");
    expect(sent).toHaveLength(0);
  });

  it("registers the capture, queues it and redirects to it", async () => {
    const response = await call("/submit", form("https://x.com/ada/status/2122184794209714368?s=20", { ...(await signedIn()), origin: "https://xposts.test" }));
    expect(response.status).toBe(303);
    const location = response.headers.get("location")!;
    expect(location).toMatch(/^\/p\/2122184794209714368\/\d{14}$/);
    const [, , postId, ts] = location.split("/");
    const capture = await getCapture(env.DB, { postId: postId!, ts: ts! });
    expect(capture).toMatchObject({ status: "pending", source: "web", requestedBy: "auth0|ada" });
    expect(sent).toEqual([{ postId, ts }]);
  });
});

describe("capture page", () => {
  it("waits while pending, polling the API", async () => {
    await insert("100", "20261116100000");
    const html = await (await call("/p/100/20261116100000")).text();
    expect(html).toContain("Saving this post");
    expect(html).toContain('data-api="/api/captures/100/20261116100000"');
    expect(html).toContain("http-equiv");
  });

  it("shows the post and the proof when done, escaping post text", async () => {
    const ref = await insert("100", "20261116100000");
    await completeCapture(env.DB, ref, done);
    await env.BUCKET.put("captures/100/20261116100000/post.png", "png-bytes");
    const html = await (await call("/p/100/20261116100000")).text();
    expect(html).toContain("a".repeat(64));
    expect(html).toContain("b".repeat(64));
    expect(html).toContain("Not anchored");
    expect(html).toContain('property="og:image" content="https://xposts.test/p/100/20261116100000/post.png"');
    expect(html).toContain("https://x.com/ada/status/100");
    expect(html).toContain("2026-11-15 09:00 UTC");
    expect(html).toContain("Hello &lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("Ada &lt;b&gt;Lovelace&lt;/b&gt;");
    // Only stored files are offered for download.
    expect(html).toContain('href="/p/100/20261116100000/post.png" download');
    expect(html).not.toContain("x-page.html");
  });

  it("links the Algorand transaction when anchored", async () => {
    const ref = await insert("100", "20261116100000");
    await completeCapture(env.DB, ref, done);
    await setAnchor(env.DB, ref, { network: "mainnet", txId: "TXID123", round: 4242 });
    const html = await (await call("/p/100/20261116100000")).text();
    expect(html).toContain("https://allo.info/tx/TXID123");
    expect(html).toContain("round 4242");
    expect(html).not.toContain("Not anchored");
  });

  it("shows the error and a way to retry when failed", async () => {
    const ref = await insert("100", "20261116100000");
    await failCapture(env.DB, ref, "X API answered 429 <rate limit>");
    const signedOut = await (await call("/p/100/20261116100000")).text();
    expect(signedOut).toContain("X API answered 429 &lt;rate limit&gt;");
    expect(signedOut).toContain("Sign in to try again");
    const html = await (await call("/p/100/20261116100000", { headers: await signedIn() })).text();
    expect(html).toContain("Try again");
    expect(html).toContain('name="url" value="100"');
  });

  it("answers 404 for unknown or malformed references", async () => {
    expect((await call("/p/100/20261116100000")).status).toBe(404);
    expect((await call("/p/abc/20261116100000")).status).toBe(404);
    expect((await call("/p/100/1")).status).toBe(404);
  });
});

describe("/p/:postId", () => {
  it("is a 404 when the post has no captures", async () => {
    expect((await call("/p/100")).status).toBe(404);
  });

  it("redirects to the capture when there is only one", async () => {
    await insert("100", "20261116100000");
    const response = await call("/p/100");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/p/100/20261116100000");
  });

  it("lists every capture, newest first", async () => {
    const first = await insert("100", "20261116100000");
    await completeCapture(env.DB, first, done);
    await insert("100", "20261117100000");
    const response = await call("/p/100");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("2026-11-17 10:00 UTC");
    expect(html).toContain("2026-11-16 10:00 UTC");
    expect(html.indexOf("20261117100000")).toBeLessThan(html.indexOf("20261116100000"));
  });
});
