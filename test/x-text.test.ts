import { describe, expect, it } from "vitest";

import type { XApiTweet } from "../src/x/api";
import { apiText } from "../src/x/text";

const url = (tco: string, expanded: string, extra: object = {}) => ({
  start: 0,
  end: 0,
  url: tco,
  expanded_url: expanded,
  ...extra,
});

describe("apiText", () => {
  it("unescapes the HTML entities X escapes", () => {
    expect(apiText({ id: "1", text: "a &lt;b&gt; &amp; c &amp;lt;" })).toBe("a <b> & c &lt;");
  });

  it("prefers the full text of a note tweet, with its own entities", () => {
    const tweet: XApiTweet = {
      id: "10",
      text: "Long post start… https://t.co/short",
      entities: { urls: [url("https://t.co/short", "https://x.com/a/status/10")] },
      note_tweet: {
        text: "Long post, the whole of it https://t.co/pic",
        entities: { urls: [url("https://t.co/pic", "https://x.com/a/status/10/photo/1", { media_key: "3_1" })] },
      },
    };
    expect(apiText(tweet)).toBe("Long post, the whole of it");
  });

  it("removes the trailing link of attached media", () => {
    const tweet: XApiTweet = {
      id: "10",
      text: "Look at this https://t.co/pic",
      entities: { urls: [url("https://t.co/pic", "https://x.com/a/status/10/photo/1", { media_key: "3_1" })] },
    };
    expect(apiText(tweet)).toBe("Look at this");
  });

  it("removes a trailing link to the post itself without media_key (video links)", () => {
    const tweet: XApiTweet = {
      id: "10",
      text: "Watch https://t.co/vid",
      entities: { urls: [url("https://t.co/vid", "https://x.com/a/status/10/video/1")] },
    };
    expect(apiText(tweet)).toBe("Watch");
  });

  it("removes the trailing link of the quoted post, and media before it", () => {
    const tweet: XApiTweet = {
      id: "10",
      text: "So true https://t.co/pic https://t.co/quote",
      referenced_tweets: [{ type: "quoted", id: "5" }],
      entities: {
        urls: [
          url("https://t.co/pic", "https://x.com/a/status/10/photo/1", { media_key: "3_1" }),
          url("https://t.co/quote", "https://twitter.com/b/status/5"),
        ],
      },
    };
    expect(apiText(tweet)).toBe("So true");
  });

  it("keeps links in the middle, and trailing links X shows", () => {
    const tweet: XApiTweet = {
      id: "10",
      text: "Read https://t.co/mid then https://t.co/end",
      entities: {
        urls: [url("https://t.co/mid", "https://example.com/a"), url("https://t.co/end", "https://example.com/b")],
      },
    };
    expect(apiText(tweet)).toBe("Read https://t.co/mid then https://t.co/end");
  });

  it("keeps a link to the quoted post when it is not at the end", () => {
    const tweet: XApiTweet = {
      id: "10",
      text: "See https://t.co/quote for context",
      referenced_tweets: [{ type: "quoted", id: "5" }],
      entities: { urls: [url("https://t.co/quote", "https://x.com/b/status/5")] },
    };
    expect(apiText(tweet)).toBe("See https://t.co/quote for context");
  });

  it("keeps a trailing link to a post that is not quoted", () => {
    const tweet: XApiTweet = {
      id: "10",
      text: "Earlier: https://t.co/other",
      entities: { urls: [url("https://t.co/other", "https://x.com/b/status/7")] },
    };
    expect(apiText(tweet)).toBe("Earlier: https://t.co/other");
  });
});
