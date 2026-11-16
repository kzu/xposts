import type { Anchor, ArchiveJob, Capture, CaptureRef } from "./types";

interface Row {
  post_id: string;
  ts: string;
  status: Capture["status"];
  error: string | null;
  source: Capture["source"];
  requested_by: string;
  mention_id: string | null;
  reply_id: string | null;
  author_handle: string | null;
  author_name: string | null;
  text: string | null;
  posted_at: string | null;
  captured_at: string | null;
  png_sha256: string | null;
  manifest_sha256: string | null;
  width: number | null;
  height: number | null;
  anchor_network: Capture["anchorNetwork"];
  anchor_txid: string | null;
  anchor_round: number | null;
  created_at: string;
}

function toCapture(row: Row): Capture {
  return {
    postId: row.post_id,
    ts: row.ts,
    status: row.status,
    error: row.error,
    source: row.source,
    requestedBy: row.requested_by,
    mentionId: row.mention_id,
    replyId: row.reply_id,
    authorHandle: row.author_handle,
    authorName: row.author_name,
    text: row.text,
    postedAt: row.posted_at,
    capturedAt: row.captured_at,
    pngSha256: row.png_sha256,
    manifestSha256: row.manifest_sha256,
    width: row.width,
    height: row.height,
    anchorNetwork: row.anchor_network,
    anchorTxid: row.anchor_txid,
    anchorRound: row.anchor_round,
    createdAt: row.created_at,
  };
}

/** UTC time as YYYYMMDDHHmmss. */
export function timestamp(date: Date): string {
  return date.toISOString().replace(/\D/g, "").slice(0, 14);
}

/** A capture of the same post younger than this is reused instead of taking another. */
const REUSE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Registers a capture and queues it, unless the post has a pending or done
 * capture from the last few minutes, which is returned instead.
 */
export async function requestCapture(
  env: { DB: D1Database; ARCHIVE_QUEUE: Queue<ArchiveJob> },
  request: {
    postId: string;
    source: Capture["source"];
    requestedBy: string;
    mention?: ArchiveJob["mention"];
  },
  now = new Date(),
): Promise<{ capture: Capture; created: boolean }> {
  const latest = await latestCapture(env.DB, request.postId, { includeFailed: false });
  if (latest && now.getTime() - Date.parse(latest.createdAt) < REUSE_WINDOW_MS) {
    return { capture: latest, created: false };
  }
  const ref: CaptureRef = { postId: request.postId, ts: timestamp(now) };
  await env.DB.prepare(
    `INSERT INTO captures (post_id, ts, source, requested_by, mention_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(ref.postId, ref.ts, request.source, request.requestedBy, request.mention?.id ?? null, now.toISOString())
    .run();
  await env.ARCHIVE_QUEUE.send({ ...ref, mention: request.mention });
  const capture = await getCapture(env.DB, ref);
  if (!capture) throw new Error(`capture ${ref.postId}/${ref.ts} vanished after insert`);
  return { capture, created: true };
}

export async function getCapture(db: D1Database, ref: CaptureRef): Promise<Capture | null> {
  const row = await db
    .prepare("SELECT * FROM captures WHERE post_id = ? AND ts = ?")
    .bind(ref.postId, ref.ts)
    .first<Row>();
  return row ? toCapture(row) : null;
}

export async function latestCapture(
  db: D1Database,
  postId: string,
  options: { includeFailed: boolean } = { includeFailed: true },
): Promise<Capture | null> {
  const filter = options.includeFailed ? "" : "AND status != 'failed'";
  const row = await db
    .prepare(`SELECT * FROM captures WHERE post_id = ? ${filter} ORDER BY ts DESC LIMIT 1`)
    .bind(postId)
    .first<Row>();
  return row ? toCapture(row) : null;
}

/** Every capture of a post, newest first. */
export async function listCaptures(db: D1Database, postId: string): Promise<Capture[]> {
  const { results } = await db
    .prepare("SELECT * FROM captures WHERE post_id = ? ORDER BY ts DESC")
    .bind(postId)
    .all<Row>();
  return results.map(toCapture);
}

/** Finished captures, newest first. */
export async function recentCaptures(db: D1Database, limit = 24): Promise<Capture[]> {
  const { results } = await db
    .prepare("SELECT * FROM captures WHERE status = 'done' ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<Row>();
  return results.map(toCapture);
}

/** Finished captures of one author, newest first. */
export async function capturesByAuthor(db: D1Database, handle: string, limit = 100): Promise<Capture[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM captures WHERE status = 'done' AND author_handle = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?",
    )
    .bind(handle, limit)
    .all<Row>();
  return results.map(toCapture);
}

/** The capture whose PNG or manifest has this hex SHA-256. */
export async function findByHash(db: D1Database, sha256: string): Promise<Capture | null> {
  const row = await db
    .prepare("SELECT * FROM captures WHERE png_sha256 = ?1 OR manifest_sha256 = ?1 LIMIT 1")
    .bind(sha256.toLowerCase())
    .first<Row>();
  return row ? toCapture(row) : null;
}

export async function completeCapture(
  db: D1Database,
  ref: CaptureRef,
  done: {
    authorHandle: string | null;
    authorName: string | null;
    text: string;
    postedAt: string | null;
    capturedAt: string;
    pngSha256: string;
    manifestSha256: string;
    width: number;
    height: number;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE captures SET status = 'done', error = NULL, author_handle = ?, author_name = ?, text = ?,
         posted_at = ?, captured_at = ?, png_sha256 = ?, manifest_sha256 = ?, width = ?, height = ?
       WHERE post_id = ? AND ts = ?`,
    )
    .bind(
      done.authorHandle,
      done.authorName,
      done.text,
      done.postedAt,
      done.capturedAt,
      done.pngSha256,
      done.manifestSha256,
      done.width,
      done.height,
      ref.postId,
      ref.ts,
    )
    .run();
}

export async function failCapture(db: D1Database, ref: CaptureRef, error: string): Promise<void> {
  await db
    .prepare("UPDATE captures SET status = 'failed', error = ? WHERE post_id = ? AND ts = ? AND status != 'done'")
    .bind(error.slice(0, 1000), ref.postId, ref.ts)
    .run();
}

export async function setAnchor(db: D1Database, ref: CaptureRef, anchor: Anchor): Promise<void> {
  await db
    .prepare("UPDATE captures SET anchor_network = ?, anchor_txid = ?, anchor_round = ? WHERE post_id = ? AND ts = ?")
    .bind(anchor.network, anchor.txId, anchor.round, ref.postId, ref.ts)
    .run();
}

export async function setReply(db: D1Database, ref: CaptureRef, replyId: string): Promise<void> {
  await db
    .prepare("UPDATE captures SET reply_id = ? WHERE post_id = ? AND ts = ?")
    .bind(replyId, ref.postId, ref.ts)
    .run();
}

export async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}
