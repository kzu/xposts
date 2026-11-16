import { describe, expect, it } from "vitest";

import type { Env } from "../src/types";
import { readPost, XApiError, XURL_READ_POST_FIELDS } from "../src/x";

const env = { X_BEARER_TOKEN: "bearer-token" } as Env;

function mockFetch(status: number, body: string, headers: Record<string, string> = {}) {
  const calls: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return new Response(body, { status, headers });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const ok = JSON.stringify({ data: { id: "20", text: "just setting up my twttr", edit_history_tweet_ids: ["20"] } });

describe("readPost", () => {
  it("requests every field of xurl's ReadPost, plus the archive's, with the bearer token", async () => {
    const { calls, fetchImpl } = mockFetch(200, ok);
    const capture = await readPost(env, "20", fetchImpl);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.x.com/2/tweets/20");
    expect(capture.url).toBe(calls[0]!.url);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer bearer-token");
    for (const [key, fields] of Object.entries(XURL_READ_POST_FIELDS)) {
      const sent = url.searchParams.get(key)?.split(",") ?? [];
      for (const field of fields) expect(sent, `${key} ${field}`).toContain(field);
    }
    expect(url.searchParams.get("tweet.fields")).toContain("edit_history_tweet_ids");
    expect(url.searchParams.get("expansions")).toContain("referenced_tweets.id.author_id");
    expect(url.searchParams.get("user.fields")).toContain("verified_type");
    expect(url.searchParams.get("media.fields")).toContain("alt_text");
  });

  it("keeps the body bytes exactly and every header lower-cased", async () => {
    // Odd spacing and an escaped character that a re-serialization would change.
    const raw = '{ "data" : {"id":"20","text":"caf\\u00e9"} }\n';
    const { fetchImpl } = mockFetch(200, raw, { "X-Transaction-ID": "abc", "Content-Type": "application/json" });
    const capture = await readPost(env, "20", fetchImpl);
    expect(capture.body).toEqual(new TextEncoder().encode(raw));
    expect(capture.status).toBe(200);
    expect(capture.headers["x-transaction-id"]).toBe("abc");
    expect(capture.headers["content-type"]).toBe("application/json");
    expect(capture.json.data.text).toBe("café");
  });

  it("throws a non-retryable error for a 200 without data, with the API's detail", async () => {
    const body = JSON.stringify({
      errors: [{ detail: "Could not find tweet with id: [20].", title: "Not Found Error", resource_id: "20" }],
    });
    const { fetchImpl } = mockFetch(200, body);
    const error = await readPost(env, "20", fetchImpl).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(XApiError);
    expect((error as XApiError).message).toContain("Could not find tweet with id: [20].");
    expect((error as XApiError).retryable).toBe(false);
    expect((error as XApiError).body).toBe(body);
  });

  it("marks rate limits and server errors retryable, and client errors not", async () => {
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [401, false],
      [404, false],
    ] as const) {
      const { fetchImpl } = mockFetch(status, JSON.stringify({ title: "Problem", detail: `status ${status}` }));
      const error = (await readPost(env, "20", fetchImpl).catch((e: unknown) => e)) as XApiError;
      expect(error).toBeInstanceOf(XApiError);
      expect(error.status).toBe(status);
      expect(error.retryable).toBe(retryable);
      expect(error.message).toContain(`status ${status}`);
    }
  });

  it("refuses to run without a bearer token or with a bad id", async () => {
    const { fetchImpl, calls } = mockFetch(200, ok);
    await expect(readPost({} as Env, "20", fetchImpl)).rejects.toThrow(/X_BEARER_TOKEN/);
    await expect(readPost(env, "20/../x", fetchImpl)).rejects.toThrow(/not a post id/);
    expect(calls).toHaveLength(0);
  });
});
