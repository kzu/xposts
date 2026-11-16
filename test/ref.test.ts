import { describe, expect, it } from "vitest";

import { parsePostRef, postUrl, snowflakeTime } from "../src/x/ref";

describe("parsePostRef", () => {
  it("reads post URLs, with share parameters and media paths", () => {
    expect(parsePostRef("https://x.com/rauchg/status/2122184794209714368/video/1?a=b&s=19")).toEqual({
      id: "2122184794209714368",
      handle: "rauchg",
    });
    expect(parsePostRef("twitter.com/jack/status/20")).toEqual({ id: "20", handle: "jack" });
    expect(parsePostRef("https://x.com/i/web/status/20")).toEqual({ id: "20" });
    expect(parsePostRef(" 20 ")).toEqual({ id: "20" });
  });

  it("refuses anything else", () => {
    expect(parsePostRef("https://x.com/rauchg")).toBeNull();
    expect(parsePostRef("https://example.com/x.com/a/status/1")).toBeNull();
    expect(parsePostRef("")).toBeNull();
  });
});

describe("postUrl", () => {
  it("falls back to /i/ without a handle", () => {
    expect(postUrl({ id: "20" })).toBe("https://x.com/i/status/20");
    expect(postUrl({ id: "20", handle: "jack" })).toBe("https://x.com/jack/status/20");
  });
});

describe("snowflakeTime", () => {
  it("reads the creation time of a snowflake id", () => {
    expect(snowflakeTime("2122184794209714368")?.toISOString().slice(0, 19)).toBe("2026-11-16T04:27:37");
  });

  it("gives null for ids that predate snowflakes", () => {
    expect(snowflakeTime("20")).toBeNull();
  });
});
