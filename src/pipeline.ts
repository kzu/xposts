// Taking a capture: read the post from X, render it, store the evidence,
// anchor its hashes on Algorand, and answer the mention that asked for it.
//
// Every stage is skipped when a previous attempt already finished it, so a
// queue retry never renders, anchors or replies twice.

import { anchor, isAnchorConfigured } from "./chain";
import { completeCapture, failCapture, getCapture, getState, setAnchor, setReply, setState } from "./db";
import { getRenderer, RENDER_OPTIONS, type Post, type Renderer } from "./render/xeet";
import { putArtifact, sha256Hex } from "./storage";
import {
  ARTIFACTS,
  captureKey,
  captureUrl,
  type Artifact,
  type ArchiveJob,
  type Capture,
  type CaptureRef,
  type Env,
  type Fingerprint,
  type Manifest,
} from "./types";
import {
  apiText,
  isBotConfigured,
  isReadConfigured,
  postFromApi,
  postUrl,
  readPost,
  replyText,
  replyWithImage,
  snowflakeTime,
  XApiError,
  type XApiCapture,
} from "./x";

/** A capture that cannot be completed. `retryable` says whether trying again can help. */
export class CaptureError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

/** The outside world a capture touches, replaceable in tests. */
export interface Services {
  renderer: Renderer;
  readPost: typeof readPost;
  anchor: typeof anchor;
  replyWithImage: typeof replyWithImage;
  replyText: typeof replyText;
  fetchBytes(url: string): Promise<Uint8Array | null>;
  now(): Date;
}

export function services(env: Env): Services {
  return {
    renderer: getRenderer(env.ASSETS),
    readPost,
    anchor,
    replyWithImage,
    replyText,
    fetchBytes,
    now: () => new Date(),
  };
}

/** X refuses images over 5 MB; a reply to a larger capture carries the link alone. */
const MAX_REPLY_IMAGE_BYTES = 5 * 1024 * 1024;
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

/** Runs one queued job to the end. Throws `CaptureError` when the capture cannot be taken. */
export async function runJob(env: Env, job: ArchiveJob, deps: Services = services(env)): Promise<void> {
  let capture = await getCapture(env.DB, job);
  if (!capture) throw new CaptureError(`capture ${job.postId}/${job.ts} is not registered`, false);

  if (capture.status !== "done") {
    await takeCapture(env, job, deps);
    capture = (await getCapture(env.DB, job))!;
  }
  if (!capture.anchorTxid && isAnchorConfigured(env)) {
    const result = await deps.anchor(env, {
      postId: capture.postId,
      ts: capture.ts,
      png: capture.pngSha256!,
      manifest: capture.manifestSha256!,
      url: captureUrl(env, capture),
    });
    await setAnchor(env.DB, capture, result);
  }
  if (job.mention) await answerMention(env, capture, job.mention, deps);
}

/** Records that a job failed for good, and tells the person who asked through a mention. */
export async function abandonJob(
  env: Env,
  job: ArchiveJob,
  reason: string,
  deps: Services = services(env),
): Promise<void> {
  await failCapture(env.DB, job, reason);
  if (!job.mention || !isBotConfigured(env)) return;
  const key = repliedKey(job.mention.id);
  if (await getState(env.DB, key)) return;
  const reply = await deps.replyText(env, {
    inReplyToId: job.mention.id,
    text: `@${job.mention.authorHandle} I could not save this post: ${reason}`.slice(0, 280),
  });
  await setState(env.DB, key, reply.id);
}

/** Replies are tracked by mention, not by capture: several mentions can share one capture. */
function repliedKey(mentionId: string): string {
  return `replied:${mentionId}`;
}

async function answerMention(
  env: Env,
  capture: Capture,
  mention: NonNullable<ArchiveJob["mention"]>,
  deps: Services,
): Promise<void> {
  if (!isBotConfigured(env)) return;
  const key = repliedKey(mention.id);
  if (await getState(env.DB, key)) return;

  const text = `@${mention.authorHandle} Saved: ${captureUrl(env, capture)}`;
  const stored = await env.BUCKET.get(captureKey(capture, ARTIFACTS.png));
  const png = stored ? new Uint8Array(await stored.arrayBuffer()) : null;
  const reply =
    png && png.byteLength <= MAX_REPLY_IMAGE_BYTES
      ? await deps.replyWithImage(env, {
          inReplyToId: mention.id,
          text,
          png,
          altText: `Archived post by @${capture.authorHandle ?? "unknown"}: ${capture.text ?? ""}`.slice(0, 1000),
        })
      : await deps.replyText(env, { inReplyToId: mention.id, text });
  await setState(env.DB, key, reply.id);
  if (capture.mentionId === mention.id) await setReply(env.DB, capture, reply.id);
}

/** X's API and its page each mint their own t.co link, so links are compared as "a link". */
function comparable(text: string): string {
  return text
    .normalize("NFC")
    .replace(/https?:\/\/t\.co\/\w+/g, "<link>")
    .replace(/\s+/g, " ")
    .trim();
}

async function takeCapture(env: Env, ref: CaptureRef, deps: Services): Promise<void> {
  const now = deps.now();
  const warnings: string[] = [];

  // 1. The X API: the authoritative text, and X's own account of the post.
  let api: XApiCapture | null = null;
  if (isReadConfigured(env)) {
    try {
      api = await deps.readPost(env, ref.postId);
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
  let page: Awaited<ReturnType<Renderer["resolve"]>> | null = null;
  try {
    page = await deps.renderer.resolve(postUrl({ id: ref.postId, handle: apiAuthor?.username }), now);
  } catch (error) {
    if (!api) throw new CaptureError(`x.com did not serve the post: ${describe(error)}`, true);
    warnings.push(`x.com did not serve the post's page (${describe(error)}): rendered from the X API response`);
  }
  const pageHtml = typeof page?.source.pageHtml === "string" ? page.source.pageHtml : null;

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
      const hydrated = await deps.renderer.hydrate(built, now);
      post = hydrated.post;
      warnings.push(...hydrated.warnings);
    } catch (error) {
      post = built;
      warnings.push(`link cards could not be resolved (${describe(error)})`);
    }
  }
  // Pins the clock, so relative times never depend on when the input is rendered again.
  post = { ...post, now: now.toISOString() };

  // 4. Render.
  const { png, report } = await deps.renderer.render(post);
  warnings.push(...report.warnings);

  // 5. Store the evidence, then the manifest that hashes it.
  const encoder = new TextEncoder();
  const pngArtifact = await putArtifact(env.BUCKET, ref, ARTIFACTS.png, png);
  const artifacts: Artifact[] = [pngArtifact];
  const input = { package: "@xeet/core", version: deps.renderer.version, options: RENDER_OPTIONS, post };
  artifacts.push(await putArtifact(env.BUCKET, ref, ARTIFACTS.xeetInput, encoder.encode(JSON.stringify(input))));
  if (api) {
    const { "set-cookie": _cookies, ...headers } = api.headers;
    const request = { url: api.url, status: api.status, headers };
    artifacts.push(await putArtifact(env.BUCKET, ref, ARTIFACTS.xApi, api.body));
    artifacts.push(
      await putArtifact(env.BUCKET, ref, ARTIFACTS.xApiHeaders, encoder.encode(JSON.stringify(request, null, 2))),
    );
  }
  if (pageHtml) artifacts.push(await putArtifact(env.BUCKET, ref, ARTIFACTS.xPage, encoder.encode(pageHtml)));

  const text = fullText ?? post.text;
  const authorHandle = apiAuthor?.username ?? post.author?.handle ?? null;
  const authorName = apiAuthor?.name ?? post.author?.name ?? null;
  const postedAt = apiPost?.created_at ?? post.createdAt ?? null;
  const manifest: Manifest = {
    schema: "xposts/manifest/v1",
    postId: ref.postId,
    ts: ref.ts,
    url: postUrl({ id: ref.postId, handle: authorHandle ?? undefined }),
    capturedAt: now.toISOString(),
    post: { authorHandle, authorName, text, postedAt },
    renderer: {
      package: "@xeet/core",
      version: deps.renderer.version,
      upstream: deps.renderer.upstream,
      options: RENDER_OPTIONS,
    },
    text: { source: fullText !== null ? "x-api" : "x-page", sourcesMatch },
    fingerprint: fingerprint(ref.postId, api, page?.source.appVersion),
    artifacts,
    warnings: [...new Set(warnings)],
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest, null, 2));
  await putArtifact(env.BUCKET, ref, ARTIFACTS.manifest, manifestBytes);

  await completeCapture(env.DB, ref, {
    authorHandle,
    authorName,
    text,
    postedAt,
    capturedAt: manifest.capturedAt,
    pngSha256: pngArtifact.sha256,
    manifestSha256: await sha256Hex(manifestBytes),
    width: Math.ceil(report.size.width * RENDER_OPTIONS.dpr),
    height: Math.ceil(report.size.height * RENDER_OPTIONS.dpr),
  });
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
