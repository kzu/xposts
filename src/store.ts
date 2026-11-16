// The archive's store. Everything lives in Azure Blob Storage (src/azure.ts);
// tests use an in-memory store with the same behaviour (test/memory-store.ts).

import type { FileKind, Save, SaveRef } from "./types";

/** What the archive supplies for a new save; the store adds what Azure states about the blob. */
export type NewSave = Omit<Save, "blob">;

export interface SaveFiles {
  png: Uint8Array;
  record: Uint8Array;
  xeetInput: Uint8Array;
  xApi?: Uint8Array;
}

export interface Store {
  /** The save of a post, or null. `username` is matched lower-cased. */
  getSave(ref: SaveRef): Promise<Save | null>;
  /** The save of a post whose author is not known. */
  findByPostId(postId: string): Promise<Save | null>;
  /** The save whose image has this hex SHA-256. */
  findBySha256(sha256: string): Promise<Save | null>;
  /** Every save of one author's posts, newest post first. */
  listSaves(username: string): Promise<Save[]>;
  /** The latest saves across all authors, newest save first. */
  recentSaves(limit: number): Promise<Save[]>;
  /**
   * Stores a save. The first save of a post wins and is never replaced: when
   * the post is already saved, nothing is written and that save is returned.
   */
  createSave(save: NewSave, files: SaveFiles): Promise<{ save: Save; created: boolean }>;
  /** Public URL of one file of a save. */
  fileUrl(ref: SaveRef, kind: FileKind): string;
  /** One file of a save, or null when the save has none of that kind. */
  readFile(ref: SaveRef, kind: FileKind): Promise<Uint8Array | null>;

  /** Small private values, such as the id of the last mention handled. */
  getState(key: string): Promise<string | null>;
  setState(key: string, value: string): Promise<void>;
  /** Atomically takes a one-time token: true for the first caller of a key, false for every later one. */
  claim(key: string): Promise<boolean>;
}

/** Handles are case-insensitive on X; saves are stored under the lower-cased handle. */
export function normalizeUsername(handle: string): string {
  return handle.toLowerCase();
}

const EXCERPT_CHARS = 280;

export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS - 1).join("")}…` : flat;
}
