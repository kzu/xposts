// X API v2 response types (as far as the fields this archive requests go),
// and the transport shared by every request: the error type and the fetch
// that turns a non-2xx response into it.

export const API_ORIGIN = "https://api.x.com";

export type FetchImpl = typeof fetch;

export interface XApiUrlEntity {
  start: number;
  end: number;
  /** The t.co link as it appears in the text. */
  url: string;
  expanded_url?: string;
  display_url?: string;
  /** Present when the link is the one X adds for attached media. */
  media_key?: string;
  status?: number;
  title?: string;
  description?: string;
  unwound_url?: string;
}

export interface XApiEntities {
  urls?: XApiUrlEntity[];
  mentions?: { start: number; end: number; username: string; id?: string }[];
  hashtags?: { start: number; end: number; tag: string }[];
  cashtags?: { start: number; end: number; tag: string }[];
}

export interface XApiPublicMetrics {
  retweet_count?: number;
  reply_count?: number;
  like_count?: number;
  quote_count?: number;
  bookmark_count?: number;
  impression_count?: number;
}

export interface XApiReferencedTweet {
  type: "quoted" | "replied_to" | "retweeted";
  id: string;
}

export interface XApiTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: XApiReferencedTweet[];
  entities?: XApiEntities;
  attachments?: { media_keys?: string[]; poll_ids?: string[] };
  public_metrics?: XApiPublicMetrics;
  /** The full text of a long post; `text` then holds only its start. */
  note_tweet?: { text: string; entities?: XApiEntities };
  article?: { title?: string; preview_text?: string; cover_media?: string; media_entities?: string[] };
  edit_history_tweet_ids?: string[];
  edit_controls?: { edits_remaining: number; is_edit_eligible: boolean; editable_until: string };
  lang?: string;
}

export interface XApiUser {
  id: string;
  name: string;
  username: string;
  verified?: boolean;
  verified_type?: "none" | "blue" | "business" | "government";
  profile_image_url?: string;
  protected?: boolean;
}

export interface XApiMediaVariant {
  bit_rate?: number;
  content_type: string;
  url: string;
}

export interface XApiMedia {
  media_key: string;
  type: "photo" | "animated_gif" | "video";
  url?: string;
  preview_image_url?: string;
  variants?: XApiMediaVariant[];
  width?: number;
  height?: number;
  duration_ms?: number;
  alt_text?: string;
}

export interface XApiIncludes {
  users?: XApiUser[];
  tweets?: XApiTweet[];
  media?: XApiMedia[];
}

/** A problem the API reports, either alone (a failed request) or beside data (a partial result). */
export interface XApiProblem {
  title?: string;
  detail?: string;
  type?: string;
  resource_type?: string;
  resource_id?: string;
  parameter?: string;
  value?: string;
}

export interface XApiPostResponse {
  data: XApiTweet;
  includes?: XApiIncludes;
  errors?: XApiProblem[];
}

export class XApiError extends Error {
  readonly status: number;
  /** The response body as text, for logs and stored failure reasons. */
  readonly body: string;
  /** Rate limits and server errors pass; anything else will fail again. */
  readonly retryable: boolean;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "XApiError";
    this.status = status;
    this.body = body;
    this.retryable = status === 429 || status >= 500;
  }
}

/** The most specific description the API gave in an error body, if any. */
export function problemDetail(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { errors, detail, title } = body as { errors?: XApiProblem[]; detail?: string; title?: string };
  const first = errors?.[0];
  return first?.detail ?? first?.title ?? detail ?? title ?? null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Sends a request and returns the response with its body read. A non-2xx
 * status throws XApiError, described by `what` and the API's own detail.
 */
export async function send(
  what: string,
  url: string,
  init: RequestInit,
  fetchImpl: FetchImpl,
): Promise<{ response: Response; bytes: Uint8Array; text: string }> {
  const response = await fetchImpl(url, init);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  if (!response.ok) {
    const detail = problemDetail(parseJson(text));
    throw new XApiError(
      `${what} failed: X API returned ${response.status}${detail ? `: ${detail}` : ""}`,
      response.status,
      text,
    );
  }
  return { response, bytes, text };
}

/** `send` for endpoints that answer JSON. */
export async function sendJson<T>(what: string, url: string, init: RequestInit, fetchImpl: FetchImpl): Promise<T> {
  const { response, text } = await send(what, url, init, fetchImpl);
  const json = parseJson(text);
  if (json === null) throw new XApiError(`${what} failed: X API returned a body that is not JSON`, response.status, text);
  return json as T;
}
