// Post references: the ids and URLs people paste.

const POST_URL =
  /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:([A-Za-z0-9_]{1,15})|i(?:\/web)?)\/status(?:es)?\/(\d{1,20})(?:[/?#].*)?$/i;

export interface PostRef {
  id: string;
  /** The author's handle, when the reference names one. */
  handle?: string;
}

/** Reads a post id from an x.com or twitter.com post URL, or from a bare id. */
export function parsePostRef(input: string): PostRef | null {
  const text = input.trim();
  if (/^\d{1,20}$/.test(text)) return { id: text };
  const match = POST_URL.exec(text);
  if (!match?.[2]) return null;
  return match[1] ? { id: match[2], handle: match[1] } : { id: match[2] };
}

/** The canonical URL of a post. X redirects `i` to the author's handle. */
export function postUrl(ref: PostRef): string {
  return `https://x.com/${ref.handle ?? "i"}/status/${ref.id}`;
}

/** First millisecond of the snowflake epoch X ids count from. */
const SNOWFLAKE_EPOCH_MS = 1288834974657n;

/**
 * When a post was created, read from its id. Ids before snowflakes (2010)
 * carry no time and give null.
 */
export function snowflakeTime(id: string): Date | null {
  const value = BigInt(id);
  if (value < 1n << 22n << 6n) return null;
  return new Date(Number((value >> 22n) + SNOWFLAKE_EPOCH_MS));
}
