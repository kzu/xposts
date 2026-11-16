import { describe, expect, it, vi } from "vitest";

import { createSaver, type Services } from "../src/capture";
import { CaptureError } from "../src/deps";
import { pollMentions, type Bot } from "../src/mentions";
import type { Renderer } from "../src/render/xeet";
import type { Env, SaveRecord } from "../src/types";
import { XApiError, type Mention, type XApiCapture } from "../src/x";
import { memoryStore } from "./memory-store";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const base: Env = { PUBLIC_URL: "https://xposts.example", REPO_URL: "https://github.com/kzu/xposts", X_BOT_HANDLE: "SaveXPosts" };
const withX: Env = { ...base, X_BEARER_TOKEN: "token" };
const withBot: Env = {
  ...base,
  X_API_KEY: "k",
  X_API_SECRET: "s",
  X_ACCESS_TOKEN: "t",
  X_ACCESS_SECRET: "ts",
  X_BOT_USER_ID: "99",
};

/** A renderer whose "PNG" is the text it was asked to draw, so tests can see which post was rendered. */
function fakeRenderer(pageText: string | Error): Renderer {
  return {
    version: "0.0.0-test",
    upstream: "test-upstream",
    resolve: vi.fn(async () => {
      if (pageText instanceof Error) throw pageText;
      return {
        post: { text: pageText, author: { handle: "Alice", name: "Alice A." } },
        links: {},
        media: {},
        source: { pageHtml: "<html>page</html>", appVersion: "web-1" },
        warnings: [],
      };
    }),
    hydrate: async (post) => ({ post, links: {}, media: {}, source: {}, warnings: [] }),
    render: vi.fn(async (post) => ({
      png: encoder.encode(`PNG:${post.text}`),
      report: { size: { width: 600, height: 100 }, warnings: [] } as never,
    })),
  };
}

function apiCapture(postId: string, text: string): XApiCapture {
  const json = {
    data: { id: postId, text, author_id: "7", created_at: "2026-11-16T04:27:37.000Z", edit_history_tweet_ids: [postId] },
    includes: { users: [{ id: "7", username: "Alice", name: "Alice A." }] },
  };
  return {
    url: `https://api.x.com/2/tweets/${postId}`,
    status: 200,
    headers: { date: "Mon, 16 Nov 2026 12:00:00 GMT", "x-transaction-id": "abc" },
    // Odd spacing on purpose: the stored body must be these bytes, not a re-serialization.
    body: encoder.encode(JSON.stringify(json, null, 3)),
    json: json as never,
  };
}

function deps(renderer: Renderer, overrides: Partial<Services> = {}): Services {
  return {
    renderer: async () => renderer,
    readPost: vi.fn(async () => {
      throw new Error("readPost was not expected");
    }),
    fetchBytes: async () => null,
    now: () => NOW,
    ...overrides,
  };
}

const request = (id: string, handle?: string) => ({
  post: handle ? { id, handle } : { id },
  source: "web" as const,
  requestedBy: "auth0|me",
});

async function recordOf(store: ReturnType<typeof memoryStore>, postId: string): Promise<SaveRecord> {
  const bytes = await store.readFile({ username: "alice", postId }, "record");
  return JSON.parse(decoder.decode(bytes!)) as SaveRecord;
}

describe("save", () => {
  it("saves from the x.com page alone when the X API is not configured", async () => {
    const store = memoryStore(() => NOW);
    const { save, created } = await createSaver(base, store, deps(fakeRenderer("hello")))(request("101", "alice"));

    expect(created).toBe(true);
    expect(save).toMatchObject({ username: "alice", handle: "Alice", postId: "101", excerpt: "hello", width: 1200 });
    const record = await recordOf(store, "101");
    expect(record.text).toEqual({ source: "x-page", sourcesMatch: null });
    expect(record.files.png).toBe(save.pngSha256);
    expect(record.files.xApi).toBeUndefined();
    expect(await store.readFile(save, "xApi")).toBeNull();
    // Who asked stays out of the public files.
    expect(JSON.stringify(record)).not.toContain("auth0|me");
    expect(await store.getState("requests/101")).toContain("auth0|me");
  });

  it("keeps the API response byte for byte and renders the page when both agree", async () => {
    const store = memoryStore(() => NOW);
    // The two sources mint different t.co links for the same URL: that is not a disagreement.
    const api = apiCapture("102", "see https://t.co/aaa");
    const services = deps(fakeRenderer("see https://t.co/bbb"), { readPost: async () => api });
    const { save } = await createSaver(withX, store, services)(request("102"));

    expect(await store.readFile(save, "xApi")).toEqual(api.body);
    expect(decoder.decode((await store.readFile(save, "png"))!)).toBe("PNG:see https://t.co/bbb");
    const record = await recordOf(store, "102");
    expect(record.text).toEqual({ source: "x-api", sourcesMatch: true });
    expect(record.post.text).toBe("see https://t.co/aaa");
    expect(record.fingerprint).toMatchObject({
      apiCreatedAt: "2026-11-16T04:27:37.000Z",
      editHistory: ["102"],
      apiHeaders: { "x-transaction-id": "abc" },
      pageAppVersion: "web-1",
    });
  });

  it("renders from the API response when the page disagrees or is not served", async () => {
    const store = memoryStore(() => NOW);
    const disagree = deps(fakeRenderer("something else"), { readPost: async () => apiCapture("103", "the real text") });
    const first = await createSaver(withX, store, disagree)(request("103"));
    expect(decoder.decode((await store.readFile(first.save, "png"))!)).toBe("PNG:the real text");
    expect((await recordOf(store, "103")).warnings.join(" ")).toContain("disagree");

    const blocked = deps(fakeRenderer(new Error("403")), { readPost: async () => apiCapture("104", "api only") });
    const second = await createSaver(withX, store, blocked)(request("104"));
    expect(second.save.excerpt).toBe("api only");
  });

  it("never renders a saved post again, whatever handle the link names", async () => {
    const store = memoryStore(() => NOW);
    const renderer = fakeRenderer("hello");
    const save = createSaver(base, store, deps(renderer));
    const first = await save(request("105", "Alice"));

    expect(await save(request("105", "ALICE"))).toEqual({ save: first.save, created: false });
    expect(await save(request("105"))).toEqual({ save: first.save, created: false });
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(renderer.resolve).toHaveBeenCalledTimes(1);

    // A link that names another account still finds the save once X says who the author is.
    expect(await save(request("105", "mallory"))).toEqual({ save: first.save, created: false });
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(store.saves).toHaveLength(1);
  });

  it("fails for good when X says the post does not exist, and can retry when X is down", async () => {
    const store = memoryStore(() => NOW);
    const gone = deps(fakeRenderer("x"), {
      readPost: async () => {
        throw new XApiError("reading post failed: Could not find tweet", 200, "{}");
      },
    });
    await expect(createSaver(withX, store, gone)(request("106"))).rejects.toMatchObject({ retryable: false });

    const down = deps(fakeRenderer("x"), {
      readPost: async () => {
        throw new XApiError("unavailable", 503, "");
      },
    });
    await expect(createSaver(withX, store, down)(request("106"))).rejects.toMatchObject({ retryable: true });
    await expect(createSaver(base, store, deps(fakeRenderer(new Error("403"))))(request("106"))).rejects.toBeInstanceOf(
      CaptureError,
    );
    expect(store.saves).toHaveLength(0);
  });
});

describe("pollMentions", () => {
  const mention = (id: string, target: string | null): Mention => ({
    id,
    authorId: "5",
    authorHandle: "bob",
    text: "@SaveXPosts",
    target: target ? { id: target } : null,
  });

  function bot(mentions: Mention[], newestId: string): Bot & { fetchMentions: ReturnType<typeof vi.fn> } {
    return {
      fetchMentions: vi.fn(async () => ({ mentions, newestId })),
      replyWithImage: vi.fn(async () => ({ id: "reply-image" })),
      replyText: vi.fn(async () => ({ id: "reply-text" })),
    };
  }

  it("answers nothing on the first poll, then saves and answers each mention that points at a post", async () => {
    const store = memoryStore(() => NOW);
    const save = createSaver(base, store, deps(fakeRenderer("hello")));
    const mentions = [mention("1001", "201"), mention("1002", null)];

    expect(await pollMentions(withBot, { store, save }, bot(mentions, "1000"))).toEqual({ seen: 2, answered: 0 });
    expect(await store.getState("mentions.since_id")).toBe("1000");

    const x = bot(mentions, "1002");
    expect(await pollMentions(withBot, { store, save }, x)).toEqual({ seen: 2, answered: 1 });
    expect(x.fetchMentions).toHaveBeenCalledWith(withBot, "1000");
    expect(vi.mocked(x.replyWithImage).mock.calls[0]![1]).toMatchObject({
      inReplyToId: "1001",
      text: "@bob Saved: https://xposts.example/alice/201",
    });
    expect(await store.getState("mentions.since_id")).toBe("1002");
    expect(store.saves[0]).toMatchObject({ postId: "201", source: "mention" });

    // The same mentions delivered again are not answered again.
    await store.setState("mentions.since_id", "1000");
    const again = bot(mentions, "1002");
    expect(await pollMentions(withBot, { store, save }, again)).toEqual({ seen: 2, answered: 0 });
    expect(again.replyWithImage).not.toHaveBeenCalled();
  });

  it("says why when a post cannot be saved, and waits for the next poll when X is down", async () => {
    const store = memoryStore(() => NOW);
    await store.setState("mentions.since_id", "1000");
    const failing = (retryable: boolean) => async () => {
      throw new CaptureError("the post was deleted", retryable);
    };

    const down = bot([mention("1001", "201")], "1001");
    expect(await pollMentions(withBot, { store, save: failing(true) }, down)).toEqual({ seen: 1, answered: 0 });
    expect(down.replyText).not.toHaveBeenCalled();
    expect(await store.getState("mentions.since_id")).toBe("1000");

    const gone = bot([mention("1001", "201")], "1001");
    expect(await pollMentions(withBot, { store, save: failing(false) }, gone)).toEqual({ seen: 1, answered: 1 });
    expect(vi.mocked(gone.replyText).mock.calls[0]![1].text).toBe("@bob I could not save this post: the post was deleted");
    expect(await store.getState("mentions.since_id")).toBe("1001");
  });
});
