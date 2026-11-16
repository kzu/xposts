import { describe, expect, it } from "vitest";

import type { XApiPostResponse } from "../src/x/api";
import { avatarUrl, postFromApi, toBase64 } from "../src/x/convert";

const response: XApiPostResponse = {
  data: {
    id: "100",
    text: "Replying with a pic and a quote https://t.co/pic https://t.co/q",
    author_id: "1",
    created_at: "2026-11-16T04:27:37.000Z",
    in_reply_to_user_id: "3",
    referenced_tweets: [
      { type: "replied_to", id: "90" },
      { type: "quoted", id: "50" },
    ],
    attachments: { media_keys: ["3_1", "7_2"] },
    entities: {
      urls: [
        { start: 0, end: 0, url: "https://t.co/pic", expanded_url: "https://x.com/alice/status/100/photo/1", media_key: "3_1" },
        { start: 0, end: 0, url: "https://t.co/q", expanded_url: "https://x.com/bob/status/50" },
      ],
    },
    public_metrics: { reply_count: 1, retweet_count: 2, like_count: 3, quote_count: 4, bookmark_count: 5, impression_count: 6 },
  },
  includes: {
    users: [
      {
        id: "1",
        name: "Alice Corp",
        username: "alice",
        verified_type: "business",
        protected: true,
        profile_image_url: "https://pbs.twimg.com/profile_images/1/a_normal.jpg",
      },
      { id: "2", name: "Bob", username: "bob", verified_type: "blue", profile_image_url: "https://pbs.twimg.com/b_normal.png" },
      { id: "3", name: "Carol", username: "carol", verified_type: "none" },
    ],
    tweets: [{ id: "50", text: "Quoted &amp; true", author_id: "2", created_at: "2026-11-15T00:00:00.000Z" }],
    media: [
      { media_key: "3_1", type: "photo", url: "https://pbs.twimg.com/media/pic.jpg", width: 1200, height: 800, alt_text: "A cat" },
      {
        media_key: "7_2",
        type: "video",
        preview_image_url: "https://pbs.twimg.com/broken.jpg",
        width: 1920,
        height: 1080,
        duration_ms: 12500,
      },
    ],
  },
};

const bytes = (s: string) => new TextEncoder().encode(s);

describe("postFromApi", () => {
  it("maps text, author, media, quote, counts and reply", async () => {
    const fetched: string[] = [];
    const post = await postFromApi(response, {
      now: new Date("2026-11-16T05:00:00Z"),
      fetchBytes: async (url) => {
        fetched.push(url);
        if (url.includes("broken")) return null;
        return bytes(url);
      },
    });

    expect(post.text).toBe("Replying with a pic and a quote");
    expect(post.author).toEqual({
      name: "Alice Corp",
      handle: "alice",
      verified: "business",
      avatar: toBase64(bytes("https://pbs.twimg.com/profile_images/1/a_x96.jpg")),
      squareAvatar: true,
      protected: true,
    });
    expect(post.media).toEqual([
      { kind: "image", width: 1200, height: 800, alt: "A cat", data: toBase64(bytes("https://pbs.twimg.com/media/pic.jpg")) },
      // The preview image failed: no data, the rest is kept.
      { kind: "video", width: 1920, height: 1080, duration: 12.5 },
    ]);
    expect(post.quote).toEqual({
      text: "Quoted & true",
      createdAt: "2026-11-15T00:00:00.000Z",
      author: {
        name: "Bob",
        handle: "bob",
        verified: "blue",
        avatar: toBase64(bytes("https://pbs.twimg.com/b_x96.png")),
      },
    });
    expect(post.counts).toEqual({ replies: 1, reposts: 2, likes: 3, bookmarks: 5, views: 6 });
    expect(post.createdAt).toBe("2026-11-16T04:27:37.000Z");
    expect(post.now).toBe("2026-11-16T05:00:00.000Z");
    expect(post.replyToHandle).toBe("carol");
    expect(fetched).toContain("https://pbs.twimg.com/broken.jpg");
  });

  it("leaves the avatar out when the image cannot be fetched", async () => {
    const post = await postFromApi(response, {
      now: new Date(),
      fetchBytes: async () => {
        throw new Error("network down");
      },
    });
    expect(post.author?.avatar).toBeUndefined();
    expect(post.author?.handle).toBe("alice");
    expect(post.media?.[0]?.data).toBeUndefined();
  });

  it("maps a GIF from its preview image and a plain post without extras", async () => {
    const post = await postFromApi(
      {
        data: { id: "1", text: "gif", attachments: { media_keys: ["16_1"] } },
        includes: {
          media: [{ media_key: "16_1", type: "animated_gif", preview_image_url: "https://p/g.jpg", width: 10, height: 20 }],
        },
      },
      { now: new Date(0), fetchBytes: async () => bytes("g") },
    );
    expect(post).toEqual({
      text: "gif",
      media: [{ kind: "gif", width: 10, height: 20, data: toBase64(bytes("g")) }],
      now: "1970-01-01T00:00:00.000Z",
    });
  });
});

describe("avatarUrl", () => {
  it("asks for the 96px variant", () => {
    expect(avatarUrl("https://pbs.twimg.com/profile_images/1/x_normal.jpeg")).toBe(
      "https://pbs.twimg.com/profile_images/1/x_x96.jpeg",
    );
  });
});
