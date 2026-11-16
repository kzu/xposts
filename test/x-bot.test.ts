import { describe, expect, it } from "vitest";

import type { Env } from "../src/types";
import { fetchMentions, isBotConfigured, isReadConfigured, replyText, replyWithImage, XApiError } from "../src/x";

const env = {
  X_API_KEY: "key",
  X_API_SECRET: "secret",
  X_ACCESS_TOKEN: "token",
  X_ACCESS_SECRET: "token-secret",
  X_BOT_USER_ID: "999",
  X_BOT_HANDLE: "SaveXPosts",
} as Env;

interface Call {
  method: string;
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: Request;
}

/** A fetch that answers each request with the next of `responses` and records it. */
function scripted(responses: (object | Response)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      body: request,
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${request.method} ${request.url}`);
    return next instanceof Response ? next : Response.json(next);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const users = [
  { id: "1", username: "alice", name: "Alice" },
  { id: "2", username: "bob", name: "Bob" },
  { id: "999", username: "SaveXPosts", name: "Bot" },
];

describe("configuration", () => {
  it("tells which parts are configured", () => {
    expect(isBotConfigured(env)).toBe(true);
    expect(isBotConfigured({ ...env, X_BOT_USER_ID: undefined })).toBe(false);
    expect(isReadConfigured(env)).toBe(false);
    expect(isReadConfigured({ ...env, X_BEARER_TOKEN: "b" })).toBe(true);
  });
});

describe("fetchMentions", () => {
  it("picks the target of each mention by the rules, oldest first, skipping the bot", async () => {
    const { calls, fetchImpl } = scripted([
      {
        data: [
          // Links a post: wins over the reply.
          {
            id: "105",
            author_id: "1",
            text: "@SaveXPosts https://t.co/a",
            referenced_tweets: [{ type: "replied_to", id: "70" }],
            entities: {
              urls: [
                { start: 0, end: 0, url: "https://t.co/x", expanded_url: "https://example.com/not-a-post" },
                { start: 0, end: 0, url: "https://t.co/a", expanded_url: "https://x.com/carol/status/60" },
              ],
            },
          },
          // The bot's own reply: skipped, but counts for newestId.
          { id: "106", author_id: "999", text: "@alice saved", referenced_tweets: [{ type: "replied_to", id: "105" }] },
          // Quotes and replies: the quote wins; a link to the mention's own media does not count.
          {
            id: "104",
            author_id: "2",
            text: "@SaveXPosts save https://t.co/m",
            referenced_tweets: [
              { type: "replied_to", id: "80" },
              { type: "quoted", id: "81" },
            ],
            entities: {
              urls: [{ start: 0, end: 0, url: "https://t.co/m", expanded_url: "https://x.com/bob/status/104/photo/1", media_key: "3_1" }],
            },
          },
        ],
        includes: { users, tweets: [{ id: "81", text: "q", author_id: "1" }] },
        meta: { result_count: 3, newest_id: "106", oldest_id: "104", next_token: "page2" },
      },
      {
        data: [
          // Replies only: the parent, without a handle when it is not included.
          { id: "102", author_id: "1", text: "@SaveXPosts this", referenced_tweets: [{ type: "replied_to", id: "90" }] },
          // Nothing to save.
          { id: "101", author_id: "2", text: "@SaveXPosts hi" },
        ],
        includes: { users },
        meta: { result_count: 2, newest_id: "102", oldest_id: "101" },
      },
    ]);

    const result = await fetchMentions(env, "100", fetchImpl);

    expect(result.newestId).toBe("106");
    expect(result.mentions.map((m) => [m.id, m.authorHandle, m.target])).toEqual([
      ["101", "bob", null],
      ["102", "alice", { id: "90" }],
      ["104", "bob", { id: "81", handle: "alice" }],
      ["105", "alice", { id: "60", handle: "carol" }],
    ]);
    expect(result.mentions[0]).toMatchObject({ authorId: "2", text: "@SaveXPosts hi" });

    expect(calls).toHaveLength(2);
    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe("/2/users/999/mentions");
    expect(first.searchParams.get("max_results")).toBe("100");
    expect(first.searchParams.get("since_id")).toBe("100");
    expect(first.searchParams.get("pagination_token")).toBeNull();
    expect(new URL(calls[1]!.url).searchParams.get("pagination_token")).toBe("page2");
    expect(calls[0]!.authorization).toMatch(/^OAuth oauth_consumer_key="key", .*oauth_token="token"/);
  });

  it("stops after five pages, and omits since_id on the first poll", async () => {
    const page = (n: number) => ({
      data: [{ id: String(200 - n), author_id: "1", text: "@SaveXPosts" }],
      includes: { users },
      meta: { result_count: 1, next_token: `p${n + 1}` },
    });
    const { calls, fetchImpl } = scripted([0, 1, 2, 3, 4, 5].map(page));
    const result = await fetchMentions(env, null, fetchImpl);
    expect(calls).toHaveLength(5);
    expect(new URL(calls[0]!.url).searchParams.has("since_id")).toBe(false);
    expect(result.mentions.map((m) => m.id)).toEqual(["196", "197", "198", "199", "200"]);
    expect(result.newestId).toBe("200");
  });

  it("gives no newest id when there is nothing new", async () => {
    const { fetchImpl } = scripted([{ meta: { result_count: 0 } }]);
    expect(await fetchMentions(env, "100", fetchImpl)).toEqual({ mentions: [], newestId: null });
  });

  it("throws the API's error", async () => {
    const { fetchImpl } = scripted([Response.json({ title: "Too Many Requests", detail: "Too Many Requests" }, { status: 429 })]);
    const error = (await fetchMentions(env, null, fetchImpl).catch((e: unknown) => e)) as XApiError;
    expect(error).toBeInstanceOf(XApiError);
    expect(error.retryable).toBe(true);
  });
});

describe("replyWithImage", () => {
  it("initializes, appends in chunks, finalizes, sets alt text, then posts the reply", async () => {
    const png = new Uint8Array(4 * 1024 * 1024 + 10).fill(7);
    const { calls, fetchImpl } = scripted([
      { data: { id: "555", media_key: "3_555", expires_after_secs: 86400 } },
      { data: { expires_at: 1 } },
      { data: { expires_at: 1 } },
      { data: { id: "555", media_key: "3_555", size: png.length, expires_after_secs: 86400 } },
      { data: { id: "555", associated_metadata: {} } },
      { data: { id: "777", text: "Saved" } },
    ]);

    const result = await replyWithImage(env, { inReplyToId: "105", text: "Saved", png, altText: "The post" }, fetchImpl);
    expect(result).toEqual({ id: "777" });

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /2/media/upload/initialize",
      "POST /2/media/upload/555/append",
      "POST /2/media/upload/555/append",
      "POST /2/media/upload/555/finalize",
      "POST /2/media/metadata",
      "POST /2/tweets",
    ]);
    for (const call of calls) expect(call.authorization).toMatch(/^OAuth /);

    expect(await calls[0]!.body.json()).toEqual({
      media_type: "image/png",
      total_bytes: png.length,
      media_category: "tweet_image",
    });
    const segments = await Promise.all(calls.slice(1, 3).map((c) => c.body.formData()));
    expect(segments.map((f) => f.get("segment_index"))).toEqual(["0", "1"]);
    const sizes = await Promise.all(segments.map(async (f) => ((await (f.get("media") as unknown as Blob).arrayBuffer()).byteLength)));
    expect(sizes).toEqual([4 * 1024 * 1024, 10]);
    expect(await calls[4]!.body.json()).toEqual({ id: "555", metadata: { alt_text: { text: "The post" } } });
    expect(await calls[5]!.body.json()).toEqual({
      text: "Saved",
      reply: { in_reply_to_tweet_id: "105" },
      media: { media_ids: ["555"] },
    });
  });

  it("refuses a PNG over X's image limit before uploading", async () => {
    const { calls, fetchImpl } = scripted([]);
    const png = new Uint8Array(5 * 1024 * 1024 + 1);
    await expect(replyWithImage(env, { inReplyToId: "1", text: "x", png }, fetchImpl)).rejects.toThrow(/limit/);
    expect(calls).toHaveLength(0);
  });

  it("fails when processing fails", async () => {
    const { fetchImpl } = scripted([
      { data: { id: "555" } },
      { data: {} },
      { data: { id: "555", processing_info: { state: "failed", error: { message: "bad image" } } } },
    ]);
    await expect(
      replyWithImage(env, { inReplyToId: "1", text: "x", png: new Uint8Array(10) }, fetchImpl),
    ).rejects.toThrow(/bad image/);
  });
});

describe("replyText", () => {
  it("posts a reply without media", async () => {
    const { calls, fetchImpl } = scripted([{ data: { id: "778", text: "Sorry" } }]);
    expect(await replyText(env, { inReplyToId: "105", text: "Sorry" }, fetchImpl)).toEqual({ id: "778" });
    expect(calls[0]!.url).toBe("https://api.x.com/2/tweets");
    expect(calls[0]!.contentType).toBe("application/json");
    expect(await calls[0]!.body.json()).toEqual({ text: "Sorry", reply: { in_reply_to_tweet_id: "105" } });
  });

  it("refuses to post without credentials", async () => {
    const { fetchImpl } = scripted([]);
    await expect(replyText({ X_BOT_HANDLE: "b" } as Env, { inReplyToId: "1", text: "x" }, fetchImpl)).rejects.toThrow(
      /X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET missing/,
    );
  });
});
