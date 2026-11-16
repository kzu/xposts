// Saving a post: read it from X, render it, and store the image with its evidence.
//
// A post is saved once. Asking again returns the stored save without reading
// X or rendering anything.

import { createHash } from "node:crypto";

import { CaptureError, type SaveRequest } from "./deps.js";
import { getRenderer, RENDER_OPTIONS, type Post, type Renderer } from "./render/xeet.js";
import { excerptOf, normalizeUsername, type Store } from "./store.js";
import type { Env, Fingerprint, Save, SaveRecord } from "./types.js";
import {
  apiText,
  isReadConfigured,
  postFromApi,
  postUrl,
  readPost,
  snowflakeTime,
  XApiError,
  type XApiCapture,
} from "./x/index.js";

/** The outside world a save touches, replaceable in tests. */
export interface Services {
  renderer(): Promise<Renderer>;
  readPost: typeof readPost;
  fetchBytes(url: string): Promise<Uint8Array | null>;
  now(): Date;
}

export const services: Services = {
  renderer: getRenderer,
  readPost,
  fetchBytes,
  now: () => new Date(),
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength <= MAX_IMAGE_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** X's API and its page each mint their own t.co link, so links are compared as "a link". */
function comparable(text: string): string {
  return text
    .normalize("NFC")
    .replace(/https?:\/\/t\.co\/\w+/g, "<link>")
    .replace(/\s+/g, " ")
    .trim();
}

/** The `save` of src/deps.ts. */
export function createSaver(env: Env, store: Store, deps: Services = services) {
  return async function save(request: SaveRequest): Promise<{ save: Save; created: boolean }> {
    const { post: ref } = request;
    const known = ref.handle
      ? await store.getSave({ username: ref.handle, postId: ref.id })
      : await store.findByPostId(ref.id);
    if (known) return { save: known, created: false };

    const now = deps.now();
    const warnings: string[] = [];

    // 1. The X API: the authoritative text, and X's own account of the post.
    let api: XApiCapture | null = null;
    if (isReadConfigured(env)) {
      try {
        api = await deps.readPost(env, ref.id);
      } catch (error) {
        if (!(error instanceof XApiError)) throw error;
        if (!error.retryable) throw new CaptureError(error.message, false);
        throw new CaptureError(`the X API is unavailable (${error.status})`, true);
      }
    } else {
      warnings.push("X API credentials are not configured: the post was read from its x.com page only");
    }
    const apiPost = api?.json.data;
    const apiAuthor = api?.json.includes?.users?.find((user) => user.id === apiPost?.author_id);
    const fullText = apiPost ? apiText(apiPost) : null;

    // 2. The x.com page: what the renderer needs to draw the post as X does.
    const renderer = await deps.renderer();
    let page: Awaited<ReturnType<Renderer["resolve"]>> | null = null;
    try {
      page = await renderer.resolve(postUrl({ id: ref.id, handle: apiAuthor?.username ?? ref.handle }), now);
    } catch (error) {
      if (!api) throw new CaptureError(`x.com did not serve the post: ${describe(error)}`, true);
      warnings.push(`x.com did not serve the post's page (${describe(error)}): rendered from the X API response`);
    }

    // 3. The post to render. The page is used only when it says what the API says.
    let sourcesMatch: boolean | null = null;
    if (page && fullText !== null) {
      sourcesMatch = comparable(page.post.text) === comparable(fullText);
      if (!sourcesMatch) {
        warnings.push("the x.com page and the X API disagree on the text: rendered from the X API response");
      }
    }
    let post: Post;
    if (page && sourcesMatch !== false) {
      post = page.post;
      warnings.push(...page.warnings);
    } else {
      const built = await postFromApi(api!.json, { fetchBytes: deps.fetchBytes, now });
      try {
        const hydrated = await renderer.hydrate(built, now);
        post = hydrated.post;
        warnings.push(...hydrated.warnings);
      } catch (error) {
        post = built;
        warnings.push(`link cards could not be resolved (${describe(error)})`);
      }
    }
    // Pins the clock, so relative times never depend on when the input is rendered again.
    post = { ...post, now: now.toISOString() };

    const handle = apiAuthor?.username ?? post.author?.handle;
    if (!handle) throw new CaptureError("X did not say who wrote this post", false);
    // The link that was submitted may name another account than the author.
    const username = normalizeUsername(handle);
    if (username !== normalizeUsername(ref.handle ?? "")) {
      const saved = await store.getSave({ username, postId: ref.id });
      if (saved) return { save: saved, created: false };
    }

    // 4. Render.
    const { png, report } = await renderer.render(post);
    warnings.push(...report.warnings);

    // 5. Store the image with its evidence.
    const encoder = new TextEncoder();
    const input = { package: "@xeet/core", version: renderer.version, options: RENDER_OPTIONS, post };
    const xeetInput = encoder.encode(JSON.stringify(input));
    const text = fullText ?? post.text;
    const authorName = apiAuthor?.name ?? post.author?.name ?? null;
    const postedAt = apiPost?.created_at ?? post.createdAt ?? null;
    const pngSha256 = sha256Hex(png);
    const record: SaveRecord = {
      schema: "xposts/save/v1",
      postId: ref.id,
      url: postUrl({ id: ref.id, handle }),
      capturedAt: now.toISOString(),
      post: { handle, authorName, text, postedAt },
      renderer: {
        package: "@xeet/core",
        version: renderer.version,
        upstream: renderer.upstream,
        options: RENDER_OPTIONS,
      },
      text: { source: fullText !== null ? "x-api" : "x-page", sourcesMatch },
      fingerprint: fingerprint(ref.id, api, page?.source.appVersion),
      files: { png: pngSha256, xeetInput: sha256Hex(xeetInput), ...(api ? { xApi: sha256Hex(api.body) } : {}) },
      warnings: [...new Set(warnings)],
    };
    const recordBytes = encoder.encode(JSON.stringify(record, null, 2));

    const result = await store.createSave(
      {
        username,
        postId: ref.id,
        handle,
        authorName,
        excerpt: excerptOf(text),
        postedAt,
        capturedAt: record.capturedAt,
        pngSha256,
        recordSha256: sha256Hex(recordBytes),
        width: Math.ceil(report.size.width * RENDER_OPTIONS.dpr),
        height: Math.ceil(report.size.height * RENDER_OPTIONS.dpr),
        source: request.source,
      },
      { png, record: recordBytes, xeetInput, xApi: api?.body },
    );
    if (result.created) {
      // Who asked is kept out of the public container.
      await store.setState(
        `requests/${ref.id}`,
        JSON.stringify({ requestedBy: request.requestedBy, source: request.source, at: record.capturedAt }),
      );
    }
    return result;
  };
}

/** Response headers that identify the request on X's side. */
const FINGERPRINT_HEADERS = [
  "date",
  "x-transaction-id",
  "x-connection-hash",
  "x-response-time",
  "x-access-level",
  "api-version",
];

/**
 * X does not sign posts, so nothing here is proof by itself. These are the
 * facts X stated that a forgery would have to keep consistent: the id encodes
 * the creation time, the API states it too, and the edit history names every
 * version of the post.
 */
function fingerprint(postId: string, api: XApiCapture | null, pageAppVersion: unknown): Fingerprint {
  const snowflake = snowflakeTime(postId);
  const apiCreatedAt = api?.json.data.created_at ?? null;
  const apiHeaders: Record<string, string> = {};
  for (const name of FINGERPRINT_HEADERS) {
    const value = api?.headers[name];
    if (value) apiHeaders[name] = value;
  }
  return {
    snowflakeTime: snowflake?.toISOString() ?? null,
    apiCreatedAt,
    timeConsistent:
      snowflake && apiCreatedAt
        ? Math.floor(snowflake.getTime() / 1000) === Math.floor(Date.parse(apiCreatedAt) / 1000)
        : null,
    editHistory: api?.json.data.edit_history_tweet_ids ?? null,
    apiHeaders,
    pageAppVersion: typeof pageAppVersion === "string" ? pageAppVersion : null,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
