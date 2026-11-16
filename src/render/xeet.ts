// The xeet renderer (https://github.com/rauchg/xeet) on Workers.
//
// xeet is a pure function from a post to PNG bytes: the same input and the
// same xeet version always give the same bytes, which is what lets anyone
// re-render a capture's `xeet-input.json` and compare hashes.

import { bind } from "@xeet/core";
import type { Post, RenderOptions, Report, Resolved } from "@xeet/core";

import { createFontPacks, sha256Hex } from "./generated/fonts.js";
import manifest from "./generated/packs.json";
import { loadXeetWasm, XEET_VERSION } from "./generated/xeet-wasm.js";

export type { Post, RenderOptions, Report, Resolved };

/**
 * How every capture is rendered: the post's own page on x.com, light theme,
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

let renderer: Renderer | undefined;

/** The renderer, instantiated once per isolate. Font packs are read from `assets` on first use. */
export function getRenderer(assets: Fetcher): Renderer {
  if (renderer) return renderer;

  const wasm = loadXeetWasm();
  const xeet = bind(wasm);
  const fonts = createFontPacks({
    manifest,
    read: async (name) => {
      const response = await assets.fetch(`https://assets.local/xeet-fonts/${name}.bin`);
      if (!response.ok) throw new Error(`xeet font pack "${name}" is missing from assets (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    },
    hash: sha256Hex,
    register: (file, bytes) => wasm.register_font(file, bytes),
    missingPacks: (request) => wasm.missing_packs(request),
  });
  const resolveOptions = (now: Date) => ({
    media: true,
    width: RENDER_OPTIONS.width,
    dpr: RENDER_OPTIONS.dpr,
    surface: RENDER_OPTIONS.surface,
    now: now.toISOString(),
  });

  renderer = {
    version: XEET_VERSION,
    upstream: xeet.upstream,
    resolve: (url, now) => xeet.resolve(url, resolveOptions(now)),
    hydrate: (post, now) => xeet.resolve(JSON.stringify(post), resolveOptions(now)),
    async render(post) {
      await fonts.ensure({ post, options: RENDER_OPTIONS });
      return xeet.render(post, RENDER_OPTIONS);
    },
  };
  return renderer;
}
