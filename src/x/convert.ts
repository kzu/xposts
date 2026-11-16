// The renderer's input built from an X API response, for when x.com's page
// cannot be fetched and xeet cannot resolve the post itself.

import type { Post } from "../render/xeet";
import type { XApiIncludes, XApiMedia, XApiPostResponse, XApiTweet, XApiUser } from "./api";
import { apiText } from "./text";

type Author = NonNullable<Post["author"]>;
type Media = NonNullable<Post["media"]>[number];

export interface PostFromApiOptions {
  /** Downloads an image; null (or a throw) leaves that image out of the post. */
  fetchBytes: (url: string) => Promise<Uint8Array | null>;
  /** Pins the clock relative times are rendered against. */
  now: Date;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: String.fromCharCode takes its arguments on the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function fetchBase64(url: string | undefined, options: PostFromApiOptions): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const bytes = await options.fetchBytes(url);
    return bytes ? toBase64(bytes) : undefined;
  } catch {
    return undefined;
  }
}

/** The profile image at the size x.com shows on a post's page; the API gives "_normal" (48px). */
export function avatarUrl(profileImageUrl: string): string {
  return profileImageUrl.replace(/_normal(\.[a-z]+)?$/i, "_x96$1");
}

async function toAuthor(user: XApiUser, options: PostFromApiOptions): Promise<Author> {
  const type = user.verified_type;
  const author: Author = {
    name: user.name,
    handle: user.username,
    verified: type === "blue" || type === "business" || type === "government" ? type : "none",
  };
  const avatar = await fetchBase64(user.profile_image_url && avatarUrl(user.profile_image_url), options);
  if (avatar) author.avatar = avatar;
  if (type === "business") author.squareAvatar = true;
  if (user.protected) author.protected = true;
  return author;
}

const MEDIA_KIND = { photo: "image", animated_gif: "gif", video: "video" } as const;

async function toMedia(media: XApiMedia, options: PostFromApiOptions): Promise<Media> {
  if (media.width === undefined || media.height === undefined) {
    throw new Error(`media ${media.media_key} has no dimensions in the API response`);
  }
  const kind = MEDIA_KIND[media.type];
  if (!kind) throw new Error(`media ${media.media_key} has an unknown type "${media.type}"`);
  const result: Media = { kind, width: media.width, height: media.height };
  // Videos and GIFs are drawn from their preview image.
  const data = await fetchBase64(kind === "image" ? media.url : media.preview_image_url, options);
  if (data) result.data = data;
  if (media.alt_text) result.alt = media.alt_text;
  if (kind === "video" && media.duration_ms !== undefined) result.duration = media.duration_ms / 1000;
  return result;
}

async function toPost(
  tweet: XApiTweet,
  includes: XApiIncludes,
  options: PostFromApiOptions,
  depth: number,
): Promise<Post> {
  const user = (id: string | undefined) => (id ? includes.users?.find((u) => u.id === id) : undefined);
  const post: Post = { text: apiText(tweet) };

  const author = user(tweet.author_id);
  if (author) post.author = await toAuthor(author, options);

  const keys = tweet.attachments?.media_keys ?? [];
  const media = keys
    .map((key) => includes.media?.find((m) => m.media_key === key))
    .filter((m): m is XApiMedia => m !== undefined);
  if (media.length) post.media = await Promise.all(media.map((m) => toMedia(m, options)));

  if (tweet.created_at) post.createdAt = tweet.created_at;

  const quotedId = tweet.referenced_tweets?.find((r) => r.type === "quoted")?.id;
  const quoted = quotedId ? includes.tweets?.find((t) => t.id === quotedId) : undefined;
  if (quoted && depth === 0) post.quote = await toPost(quoted, includes, options, depth + 1);

  if (depth === 0) {
    const metrics = tweet.public_metrics;
    if (metrics) {
      post.counts = {
        replies: metrics.reply_count,
        reposts: metrics.retweet_count,
        likes: metrics.like_count,
        bookmarks: metrics.bookmark_count,
        views: metrics.impression_count,
      };
    }
    post.now = options.now.toISOString();
    if (tweet.referenced_tweets?.some((r) => r.type === "replied_to")) {
      const replyTo = user(tweet.in_reply_to_user_id);
      if (replyTo) post.replyToHandle = replyTo.username;
    }
  }
  return post;
}

/** Builds the renderer's input from a post lookup response (see readPost). */
export async function postFromApi(json: XApiPostResponse, options: PostFromApiOptions): Promise<Post> {
  if (!json.data) throw new Error("the X API response has no post data");
  return toPost(json.data, json.includes ?? {}, options, 0);
}
