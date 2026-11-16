// The text of a post as X displays it, from the API's representation.

import type { XApiTweet, XApiUrlEntity } from "./api.js";
import { parsePostRef } from "./ref.js";

function unescapeHtml(text: string): string {
  // &amp; last, so "&amp;lt;" becomes "&lt;" and not "<".
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * Whether X hides this link when it ends the text: the link it appends for
 * attached media, and the link to the quoted post (shown as the quote card).
 */
function isHiddenTrailingLink(entity: XApiUrlEntity, tweet: XApiTweet, quotedId: string | undefined): boolean {
  if (entity.media_key) return true;
  const ref = entity.expanded_url ? parsePostRef(entity.expanded_url) : null;
  if (!ref) return false;
  // A link to the post itself is the media link (…/status/<id>/photo/1).
  return ref.id === tweet.id || ref.id === quotedId;
}

/**
 * The complete text of a post: the long-form text of a note tweet when there
 * is one, HTML entities unescaped, and the trailing t.co links X hides
 * removed. Links elsewhere stay as their t.co form.
 */
export function apiText(tweet: XApiTweet): string {
  const note = tweet.note_tweet;
  let text = note ? note.text : tweet.text;
  const urls = (note ? note.entities?.urls : tweet.entities?.urls) ?? [];
  const quotedId = tweet.referenced_tweets?.find((r) => r.type === "quoted")?.id;
  const hidden = urls.filter((u) => isHiddenTrailingLink(u, tweet, quotedId)).map((u) => u.url);

  // Strip from the end while the text ends with a hidden link: a post with
  // media and a quote ends with both.
  let stripped = false;
  for (;;) {
    const trimmed = text.trimEnd();
    const link = hidden.find((url) => trimmed.endsWith(url));
    if (!link) break;
    text = trimmed.slice(0, -link.length);
    stripped = true;
  }
  return unescapeHtml(stripped ? text.trimEnd() : text);
}
