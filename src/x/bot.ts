// The bot account: reading its mentions and replying to them, signed with
// OAuth 1.0a.

import type { Env } from "../types";
import { API_ORIGIN, type FetchImpl, sendJson, type XApiIncludes, type XApiProblem, type XApiTweet } from "./api";
import { botCredentials, oauth1Header } from "./oauth1";
import { type PostRef, parsePostRef } from "./ref";

/** Whether the bearer token for reading posts is set. */
export function isReadConfigured(env: Env): boolean {
  return Boolean(env.X_BEARER_TOKEN);
}

/** Whether everything the bot needs to read mentions and reply is set. */
export function isBotConfigured(env: Env): boolean {
  return Boolean(env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET && env.X_BOT_USER_ID);
}

async function signedJson<T>(
  env: Env,
  what: string,
  method: "GET" | "POST",
  url: string,
  body: { json: unknown } | { multipart: FormData } | null,
  fetchImpl: FetchImpl,
): Promise<T> {
  // JSON and multipart bodies are not part of the OAuth 1.0a signature.
  const headers: Record<string, string> = {
    authorization: await oauth1Header(botCredentials(env), { method, url }),
  };
  let payload: BodyInit | undefined;
  if (body && "json" in body) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body.json);
  } else if (body) {
    payload = body.multipart;
  }
  return sendJson<T>(what, url, { method, headers, body: payload }, fetchImpl);
}

export interface Mention {
  id: string;
  authorId: string;
  authorHandle: string;
  text: string;
  /** The post the mention asks to save. */
  target: PostRef | null;
}

/** Pages of mentions read per poll; anything beyond is older than what a poll every few minutes misses. */
const MAX_MENTION_PAGES = 5;

const MENTION_QUERY =
  "tweet.fields=author_id,created_at,entities,referenced_tweets,note_tweet" +
  "&expansions=author_id,referenced_tweets.id,referenced_tweets.id.author_id" +
  "&user.fields=username";

interface MentionsPage {
  data?: XApiTweet[];
  includes?: XApiIncludes;
  errors?: XApiProblem[];
  meta?: { result_count?: number; newest_id?: string; oldest_id?: string; next_token?: string };
}

function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The post a mention asks to save: the first post linked in the mention
 * itself, else the post it quotes, else the post it replies to.
 */
export function mentionTarget(tweet: XApiTweet, includes: XApiIncludes): PostRef | null {
  const urls = tweet.note_tweet?.entities?.urls ?? tweet.entities?.urls ?? [];
  for (const entity of urls) {
    const ref = entity.expanded_url ? parsePostRef(entity.expanded_url) : null;
    // A mention's media links point to the mention itself.
    if (ref && ref.id !== tweet.id) return ref;
  }
  for (const type of ["quoted", "replied_to"] as const) {
    const id = tweet.referenced_tweets?.find((r) => r.type === type)?.id;
    if (!id) continue;
    const authorId = includes.tweets?.find((t) => t.id === id)?.author_id;
    const handle = authorId ? includes.users?.find((u) => u.id === authorId)?.username : undefined;
    return handle ? { id, handle } : { id };
  }
  return null;
}

/**
 * The bot's mentions newer than `sinceId`, oldest first, without the bot's
 * own posts. `newestId` is the newest mention id seen (the bot's own
 * included), to pass as `sinceId` next time; null when there was none.
 */
export async function fetchMentions(
  env: Env,
  sinceId: string | null,
  fetchImpl: FetchImpl = fetch,
): Promise<{ mentions: Mention[]; newestId: string | null }> {
  const botId = env.X_BOT_USER_ID;
  if (!botId) throw new Error("X_BOT_USER_ID is not configured: cannot read the bot's mentions");

  const mentions: Mention[] = [];
  let newestId: string | null = null;
  let token: string | undefined;
  for (let page = 0; page < MAX_MENTION_PAGES; page++) {
    let url: string = `${API_ORIGIN}/2/users/${botId}/mentions?max_results=100&${MENTION_QUERY}`;
    if (sinceId) url += `&since_id=${encodeURIComponent(sinceId)}`;
    if (token) url += `&pagination_token=${encodeURIComponent(token)}`;
    const result: MentionsPage = await signedJson<MentionsPage>(env, "reading mentions", "GET", url, null, fetchImpl);

    const includes = result.includes ?? {};
    for (const tweet of result.data ?? []) {
      if (!newestId || compareIds(tweet.id, newestId) > 0) newestId = tweet.id;
      if (!tweet.author_id) throw new Error(`mention ${tweet.id} came without author_id`);
      if (tweet.author_id === botId) continue;
      const author = includes.users?.find((u) => u.id === tweet.author_id);
      if (!author) throw new Error(`mention ${tweet.id} came without its author ${tweet.author_id} in includes`);
      mentions.push({
        id: tweet.id,
        authorId: tweet.author_id,
        authorHandle: author.username,
        text: tweet.note_tweet?.text ?? tweet.text,
        target: mentionTarget(tweet, includes),
      });
    }
    token = result.meta?.next_token;
    if (!token) break;
  }
  mentions.sort((a, b) => compareIds(a.id, b.id));
  return { mentions, newestId };
}

/** X's limit for media_category tweet_image. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Append segments; the docs advise at most 5 MB each. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** X's limit for alt text. */
const MAX_ALT_TEXT = 1000;
const MAX_STATUS_CHECKS = 10;

interface ProcessingInfo {
  state: "pending" | "in_progress" | "succeeded" | "failed";
  check_after_secs?: number;
  error?: { message?: string };
}

/**
 * Uploads a PNG with the chunked v2 flow (initialize, append, finalize),
 * which the docs require for files of several MB, and returns its media id.
 */
async function uploadPng(env: Env, png: Uint8Array, altText: string | undefined, fetchImpl: FetchImpl): Promise<string> {
  if (png.length === 0) throw new Error("cannot upload an empty PNG");
  if (png.length > MAX_IMAGE_BYTES) {
    throw new Error(`the PNG is ${png.length} bytes, over X's ${MAX_IMAGE_BYTES}-byte limit for images`);
  }
  const base = `${API_ORIGIN}/2/media/upload`;

  const init = await signedJson<{ data?: { id?: string } }>(
    env,
    "initializing the media upload",
    "POST",
    `${base}/initialize`,
    { json: { media_type: "image/png", total_bytes: png.length, media_category: "tweet_image" } },
    fetchImpl,
  );
  const mediaId = init.data?.id;
  if (!mediaId) throw new Error("initializing the media upload returned no media id");

  for (let offset = 0, index = 0; offset < png.length; offset += CHUNK_BYTES, index++) {
    const form = new FormData();
    form.append("segment_index", String(index));
    form.append("media", new Blob([png.slice(offset, offset + CHUNK_BYTES).buffer], { type: "image/png" }), "post.png");
    await signedJson(env, `uploading media segment ${index}`, "POST", `${base}/${mediaId}/append`, { multipart: form }, fetchImpl);
  }

  const finalized = await signedJson<{ data?: { processing_info?: ProcessingInfo } }>(
    env,
    "finalizing the media upload",
    "POST",
    `${base}/${mediaId}/finalize`,
    null,
    fetchImpl,
  );
  // Images are usually ready at once; processing_info appears only when not.
  let info = finalized.data?.processing_info;
  for (let check = 0; info && info.state !== "succeeded"; check++) {
    if (info.state === "failed") throw new Error(`X failed to process the image: ${info.error?.message ?? "no reason given"}`);
    if (check === MAX_STATUS_CHECKS) throw new Error(`X was still processing media ${mediaId} after ${check} checks`);
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, info!.check_after_secs ?? 1) * 1000));
    const status = await signedJson<{ data?: { processing_info?: ProcessingInfo } }>(
      env,
      "checking the media upload",
      "GET",
      `${base}?command=STATUS&media_id=${mediaId}`,
      null,
      fetchImpl,
    );
    info = status.data?.processing_info;
  }

  if (altText) {
    await signedJson(
      env,
      "setting the image's alt text",
      "POST",
      `${API_ORIGIN}/2/media/metadata`,
      { json: { id: mediaId, metadata: { alt_text: { text: altText.slice(0, MAX_ALT_TEXT) } } } },
      fetchImpl,
    );
  }
  return mediaId;
}

async function createReply(
  env: Env,
  body: { text: string; reply: { in_reply_to_tweet_id: string }; media?: { media_ids: string[] } },
  fetchImpl: FetchImpl,
): Promise<{ id: string }> {
  const result = await signedJson<{ data?: { id?: string } }>(
    env,
    `replying to ${body.reply.in_reply_to_tweet_id}`,
    "POST",
    `${API_ORIGIN}/2/tweets`,
    { json: body },
    fetchImpl,
  );
  const id = result.data?.id;
  if (!id) throw new Error(`replying to ${body.reply.in_reply_to_tweet_id} returned no post id`);
  return { id };
}

/** Replies as the bot with the PNG attached. */
export async function replyWithImage(
  env: Env,
  reply: { inReplyToId: string; text: string; png: Uint8Array; altText?: string },
  fetchImpl: FetchImpl = fetch,
): Promise<{ id: string }> {
  const mediaId = await uploadPng(env, reply.png, reply.altText, fetchImpl);
  return createReply(
    env,
    { text: reply.text, reply: { in_reply_to_tweet_id: reply.inReplyToId }, media: { media_ids: [mediaId] } },
    fetchImpl,
  );
}

/** Replies as the bot with text only. */
export async function replyText(
  env: Env,
  reply: { inReplyToId: string; text: string },
  fetchImpl: FetchImpl = fetch,
): Promise<{ id: string }> {
  return createReply(env, { text: reply.text, reply: { in_reply_to_tweet_id: reply.inReplyToId } }, fetchImpl);
}
