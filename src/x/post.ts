// Reading one post with app-only auth, keeping the response as evidence.

import type { Env } from "../types.js";
import { API_ORIGIN, type FetchImpl, problemDetail, send, XApiError, type XApiPostResponse } from "./api.js";

type FieldSet = Record<"tweet.fields" | "expansions" | "user.fields" | "media.fields", readonly string[]>;

/** The fields of ReadPost in kzu/xurl (api/shortcuts.go), the reference this client follows. */
export const XURL_READ_POST_FIELDS = {
  "tweet.fields": [
    "created_at",
    "public_metrics",
    "conversation_id",
    "in_reply_to_user_id",
    "referenced_tweets",
    "entities",
    "attachments",
    "text",
    "note_tweet",
    "article",
    "author_id",
  ],
  expansions: ["author_id", "referenced_tweets.id", "attachments.media_keys", "article.cover_media", "article.media_entities"],
  "user.fields": ["username", "name", "verified", "profile_image_url"],
  "media.fields": ["url", "preview_image_url", "type", "variants"],
} as const satisfies FieldSet;

/**
 * What the archive needs beyond xurl: the edit history for the fingerprint,
 * the quoted post's author and the replied-to handle for the render, the
 * verification type and protected flag for the author badge, and media
 * dimensions, duration and alt text so the render matches x.com.
 */
export const ARCHIVE_EXTRA_FIELDS = {
  "tweet.fields": ["edit_history_tweet_ids", "edit_controls", "lang"],
  expansions: ["referenced_tweets.id.author_id", "in_reply_to_user_id"],
  "user.fields": ["verified_type", "protected"],
  "media.fields": ["width", "height", "duration_ms", "alt_text"],
} as const satisfies FieldSet;

/** The query string of the post lookup, commas left literal as xurl sends them. */
export function readPostQuery(): string {
  const keys = Object.keys(XURL_READ_POST_FIELDS) as (keyof FieldSet)[];
  return keys
    .map((key) => `${key}=${[...XURL_READ_POST_FIELDS[key], ...ARCHIVE_EXTRA_FIELDS[key]].join(",")}`)
    .join("&");
}

export interface XApiCapture {
  url: string;
  status: number;
  /** Every response header, names lower-cased. */
  headers: Record<string, string>;
  /** The response body exactly as received: it is stored and hashed. */
  body: Uint8Array;
  json: XApiPostResponse;
}

/**
 * Reads a post with the bearer token. Throws XApiError on a failed request,
 * and on a 200 without `data`, which is how X answers for a deleted,
 * protected or suspended post.
 */
export async function readPost(env: Env, postId: string, fetchImpl: FetchImpl = fetch): Promise<XApiCapture> {
  if (!env.X_BEARER_TOKEN) throw new Error("X_BEARER_TOKEN is not configured: cannot read posts from the X API");
  if (!/^\d{1,20}$/.test(postId)) throw new Error(`not a post id: "${postId}"`);
  const url = `${API_ORIGIN}/2/tweets/${postId}?${readPostQuery()}`;
  const what = `reading post ${postId}`;
  const { response, bytes, text } = await send(
    what,
    url,
    { headers: { authorization: `Bearer ${env.X_BEARER_TOKEN}` } },
    fetchImpl,
  );

  let json: XApiPostResponse;
  try {
    json = JSON.parse(text) as XApiPostResponse;
  } catch {
    throw new XApiError(`${what} failed: X API returned a body that is not JSON`, response.status, text);
  }
  if (!json || typeof json !== "object" || !json.data) {
    const detail = problemDetail(json) ?? "the response has no data";
    throw new XApiError(`${what} failed: ${detail}`, response.status, text);
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return { url, status: response.status, headers, body: bytes, json };
}
