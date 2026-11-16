// The xeet renderer (https://github.com/rauchg/xeet).
//
// xeet is a pure function from a post to PNG bytes: the same input and the
// same xeet version always give the same bytes, which is what lets anyone
// render a save's renderer input again and compare hashes.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { loadXeet } from "@xeet/core/node";
import type { Post, RenderOptions, Report, Resolved } from "@xeet/core";

export type { Post, RenderOptions, Report, Resolved };

/**
 * How every save is rendered: the post's own page on x.com, light theme,
 * with "Show more" expanded so the whole text is in the image.
 */
export const RENDER_OPTIONS = {
  surface: "web-detail",
  width: 600,
  theme: "light",
  dpr: 2,
  expanded: true,
} as const satisfies RenderOptions;

export interface Renderer {
  /** Version of the @xeet/core package. */
  version: string;
  /** Version of the x.com web app whose rules this xeet build carries. */
  upstream: string;
  /** Resolves an x.com post URL to a complete post, images inlined. */
  resolve(url: string, now: Date): Promise<Resolved>;
  /** Fills in what a hand-built post lacks (link cards), images inlined. */
  hydrate(post: Post, now: Date): Promise<Resolved>;
  render(post: Post): Promise<{ png: Uint8Array; report: Report }>;
}

let renderer: Promise<Renderer> | undefined;

/** The renderer, loaded once per process. Font packs are read from the package on first use. */
export function getRenderer(): Promise<Renderer> {
  renderer ??= load();
  return renderer;
}

async function load(): Promise<Renderer> {
  const xeet = await loadXeet({ lazy: true });
  // The package hides its package.json from imports, so it is read from next to its entry point.
  const entry = createRequire(import.meta.url).resolve("@xeet/core/node");
  const { version } = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as { version: string };
  const resolveOptions = (now: Date) => ({
    media: true,
    width: RENDER_OPTIONS.width,
    dpr: RENDER_OPTIONS.dpr,
    surface: RENDER_OPTIONS.surface,
    now: now.toISOString(),
  });
  return {
    version,
    upstream: xeet.upstream,
    resolve: (url, now) => xeet.resolve(url, resolveOptions(now)),
    hydrate: (post, now) => xeet.resolve(JSON.stringify(post), resolveOptions(now)),
    async render(post) {
      await xeet.ensureFonts!({ post, options: RENDER_OPTIONS });
      return xeet.render(post, RENDER_OPTIONS);
    },
  };
}
