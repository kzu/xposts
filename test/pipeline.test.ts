import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { getCapture, getState, requestCapture } from "../src/db";
import { pollMentions } from "../src/mentions";
import { abandonJob, CaptureError, runJob, type Services } from "../src/pipeline";
import type { Renderer } from "../src/render/xeet";
import { sha256Hex } from "../src/storage";
import { ARTIFACTS, captureKey, type Env, type Manifest } from "../src/types";
import { XApiError, type XApiCapture } from "../src/x";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const encoder = new TextEncoder();

/** A renderer whose "PNG" is the text it was asked to draw, so tests can see which post was rendered. */
function fakeRenderer(pageText: string | Error): Renderer {
  return {
    version: "0.0.0-test",
    upstream: "test-upstream",
    resolve: async () => {
      if (pageText instanceof Error) throw pageText;
      return {
        post: { text: pageText, author: { handle: "alice", name: "Alice" } },
        links: {},
        media: {},
        source: { pageHtml: "<html>page</html>", appVersion: "web-1" },
        warnings: [],
      };
    },
    hydrate: async (post) => ({ post, links: {}, media: {}, source: {}, warnings: [] }),
    render: async (post) => ({
      png: encoder.encode(`PNG:${post.text}`),
      report: { size: { width: 600, height: 100 }, warnings: [] } as never,
    }),
  };
}

function apiCapture(postId: string, text: string): XApiCapture {
  const json = {
    data: {
      id: postId,
      text,
      author_id: "7",
      created_at: "2026-11-16T04:27:37.000Z",
      edit_history_tweet_ids: [postId],
    },
    includes: { users: [{ id: "7", username: "alice", name: "Alice" }] },
  };
  return {
    url: `https://api.x.com/2/tweets/${postId}`,
    status: 200,
    headers: { date: "Mon, 16 Nov 2026 12:00:00 GMT", "x-transaction-id": "abc", "set-cookie": "secret=1" },
    // Odd spacing on purpose: the stored body must be these bytes, not a re-serialization.
    body: encoder.encode(JSON.stringify(json, null, 3)),
    json: json as never,
  };
}

function deps(overrides: Partial<Services>): Services {
  return {
    renderer: fakeRenderer("hello"),
    readPost: vi.fn(async () => {
      throw new Error("readPost was not expected");
    }),
    anchor: vi.fn(async () => ({ network: "testnet" as const, txId: "TX", round: 42 })),
    replyWithImage: vi.fn(async () => ({ id: "reply-image" })),
    replyText: vi.fn(async () => ({ id: "reply-text" })),
    fetchBytes: async () => null,
    now: () => NOW,
    ...overrides,
  };
}

const withX: Partial<Env> = { X_BEARER_TOKEN: "token" };
const withBot: Partial<Env> = {
  X_API_KEY: "k",
  X_API_SECRET: "s",
  X_ACCESS_TOKEN: "t",
  X_ACCESS_SECRET: "ts",
  X_BOT_USER_ID: "99",
};
const withAnchor: Partial<Env> = { ALGORAND_MNEMONIC: "words" };

async function register(testEnv: Env, postId: string, mention?: { id: string; authorHandle: string }) {
  const { capture } = await requestCapture(testEnv, { postId, source: "web", requestedBy: "auth0|me", mention }, NOW);
  return { postId: capture.postId, ts: capture.ts, mention };
}

async function stored(testEnv: Env, ref: { postId: string; ts: string }, name: string): Promise<Uint8Array | null> {
  const object = await testEnv.BUCKET.get(captureKey(ref, name));
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

describe("runJob", () => {
  it("captures from the x.com page alone when the X API is not configured", async () => {
    const job = await register(env, "2122184794209714001");
    await runJob(env, job, deps({}));

    const capture = (await getCapture(env.DB, job))!;
    expect(capture).toMatchObject({ status: "done", text: "hello", authorHandle: "alice", anchorTxid: null });

    const manifestBytes = (await stored(env, job, ARTIFACTS.manifest))!;
    expect(await sha256Hex(manifestBytes)).toBe(capture.manifestSha256);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
    expect(manifest.text).toEqual({ source: "x-page", sourcesMatch: null });
    expect(manifest.artifacts.map((a) => a.name)).toEqual([ARTIFACTS.png, ARTIFACTS.xeetInput, ARTIFACTS.xPage]);
    expect(manifest.artifacts[0]!.sha256).toBe(capture.pngSha256);
    expect(await sha256Hex((await stored(env, job, ARTIFACTS.png))!)).toBe(capture.pngSha256);
  });

  it("keeps the API response byte for byte and renders the page when both agree", async () => {
    const testEnv = { ...env, ...withX };
    const job = await register(testEnv, "2122184794209714002");
    // The two sources mint different t.co links for the same URL: that is not a disagreement.
    const api = apiCapture(job.postId, "see https://t.co/aaa");
    await runJob(testEnv, job, deps({ renderer: fakeRenderer("see https://t.co/bbb"), readPost: async () => api }));

    expect(await stored(testEnv, job, ARTIFACTS.xApi)).toEqual(api.body);
    expect(new TextDecoder().decode((await stored(testEnv, job, ARTIFACTS.png))!)).toBe("PNG:see https://t.co/bbb");
    const headers = new TextDecoder().decode((await stored(testEnv, job, ARTIFACTS.xApiHeaders))!);
    expect(headers).toContain("x-transaction-id");
    expect(headers).not.toContain("set-cookie");

    const manifest = JSON.parse(new TextDecoder().decode((await stored(testEnv, job, ARTIFACTS.manifest))!)) as Manifest;
    expect(manifest.text).toEqual({ source: "x-api", sourcesMatch: true });
    expect(manifest.post.text).toBe("see https://t.co/aaa");
    expect(manifest.fingerprint).toMatchObject({
      apiCreatedAt: "2026-11-16T04:27:37.000Z",
      editHistory: [job.postId],
      apiHeaders: { "x-transaction-id": "abc" },
      pageAppVersion: "web-1",
    });
  });

  it("renders from the API response when the page disagrees on the text", async () => {
    const testEnv = { ...env, ...withX };
    const job = await register(testEnv, "2122184794209714003");
    await runJob(
      testEnv,
      job,
      deps({ renderer: fakeRenderer("something else"), readPost: async () => apiCapture(job.postId, "the real text") }),
    );

    expect(new TextDecoder().decode((await stored(testEnv, job, ARTIFACTS.png))!)).toBe("PNG:the real text");
    const manifest = JSON.parse(new TextDecoder().decode((await stored(testEnv, job, ARTIFACTS.manifest))!)) as Manifest;
    expect(manifest.text.sourcesMatch).toBe(false);
    expect(manifest.warnings.join(" ")).toContain("disagree");
  });

  it("renders from the API response when x.com does not serve the page", async () => {
    const testEnv = { ...env, ...withX };
    const job = await register(testEnv, "2122184794209714004");
    await runJob(
      testEnv,
      job,
      deps({ renderer: fakeRenderer(new Error("403")), readPost: async () => apiCapture(job.postId, "api only") }),
    );

    expect((await getCapture(testEnv.DB, job))!.text).toBe("api only");
    expect(await stored(testEnv, job, ARTIFACTS.xPage)).toBeNull();
  });

  it("fails for good when X says the post does not exist, and can retry when X is down", async () => {
    const testEnv = { ...env, ...withX };
    const job = await register(testEnv, "2122184794209714005");
    const gone = deps({
      readPost: async () => {
        throw new XApiError("reading post failed: Could not find tweet", 200, "{}");
      },
    });
    await expect(runJob(testEnv, job, gone)).rejects.toMatchObject({ retryable: false });

    const down = deps({
      readPost: async () => {
        throw new XApiError("unavailable", 503, "");
      },
    });
    await expect(runJob(testEnv, job, down)).rejects.toMatchObject({ retryable: true });
    await expect(runJob(testEnv, job, down)).rejects.toBeInstanceOf(CaptureError);
  });

  it("anchors and answers the mention once, however often the job runs", async () => {
    const testEnv = { ...env, ...withBot, ...withAnchor };
    const job = await register(testEnv, "2122184794209714006", { id: "555", authorHandle: "bob" });
    const services = deps({});
    await runJob(testEnv, job, services);
    await runJob(testEnv, job, services);

    expect(services.anchor).toHaveBeenCalledTimes(1);
    expect(services.replyWithImage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(services.replyWithImage).mock.calls[0]![1]).toMatchObject({
      inReplyToId: "555",
      text: `@bob Saved: ${env.PUBLIC_URL}/p/${job.postId}/${job.ts}`,
    });
    const capture = (await getCapture(testEnv.DB, job))!;
    expect(capture).toMatchObject({ anchorTxid: "TX", anchorRound: 42, anchorNetwork: "testnet" });
    const anchored = vi.mocked(services.anchor).mock.calls[0]![1];
    expect(anchored).toMatchObject({ png: capture.pngSha256, manifest: capture.manifestSha256 });
  });
});

describe("abandonJob", () => {
  it("marks the capture failed and tells the person who asked", async () => {
    const testEnv = { ...env, ...withBot };
    const job = await register(testEnv, "2122184794209714007", { id: "556", authorHandle: "bob" });
    const services = deps({});
    await abandonJob(testEnv, job, "the post was deleted", services);
    await abandonJob(testEnv, job, "the post was deleted", services);

    expect(await getCapture(testEnv.DB, job)).toMatchObject({ status: "failed", error: "the post was deleted" });
    expect(services.replyText).toHaveBeenCalledTimes(1);
  });
});

describe("pollMentions", () => {
  it("answers nothing on the first poll, then queues a capture per mention that points at a post", async () => {
    const testEnv = { ...env, ...withBot };
    const mentions = [
      { id: "1001", authorId: "5", authorHandle: "bob", text: "@SaveXPosts", target: { id: "2122184794209714008" } },
      { id: "1002", authorId: "6", authorHandle: "eve", text: "@SaveXPosts hi", target: null },
    ];

    expect(await pollMentions(testEnv, async () => ({ mentions, newestId: "1000" }))).toMatchObject({ queued: 0 });
    expect(await getState(testEnv.DB, "mentions.since_id")).toBe("1000");

    const fetch = vi.fn(async () => ({ mentions, newestId: "1002" }));
    expect(await pollMentions(testEnv, fetch)).toEqual({ seen: 2, queued: 1 });
    expect(fetch).toHaveBeenCalledWith(testEnv, "1000");
    expect(await getState(testEnv.DB, "mentions.since_id")).toBe("1002");

    const { results } = await testEnv.DB.prepare("SELECT * FROM captures WHERE post_id = ?")
      .bind("2122184794209714008")
      .all();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ source: "mention", requested_by: "x:5", mention_id: "1001" });
  });
});
