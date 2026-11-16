// An in-memory Store with the behaviour of the Azure one, for tests.

import { createHash } from "node:crypto";

import { normalizeUsername, type NewSave, type SaveFiles, type Store } from "../src/store";
import { FILES, type FileKind, type Save, type SaveRef } from "../src/types";

export const MEMORY_BLOB_ORIGIN = "https://xposts.blob.core.windows.net/saves";

export function memoryStore(now: () => Date = () => new Date()): Store & { saves: Save[] } {
  const saves: Save[] = [];
  const files = new Map<string, Uint8Array>();
  const state = new Map<string, string>();
  const key = (ref: SaveRef, kind: FileKind) => `${normalizeUsername(ref.username)}/${ref.postId}${FILES[kind]}`;
  const find = (ref: SaveRef) =>
    saves.find((s) => s.username === normalizeUsername(ref.username) && s.postId === ref.postId) ?? null;

  return {
    saves,
    getSave: async (ref) => find(ref),
    findByPostId: async (postId) => saves.find((s) => s.postId === postId) ?? null,
    findBySha256: async (sha256) => saves.find((s) => s.pngSha256 === sha256.toLowerCase()) ?? null,
    listSaves: async (username) =>
      saves
        .filter((s) => s.username === normalizeUsername(username))
        .sort((a, b) => (BigInt(b.postId) > BigInt(a.postId) ? 1 : -1)),
    recentSaves: async (limit) => [...saves].reverse().slice(0, limit),
    async createSave(save: NewSave, content: SaveFiles) {
      const existing = find(save);
      if (existing) return { save: existing, created: false };
      const at = now().toISOString();
      const stored: Save = {
        ...save,
        username: normalizeUsername(save.username),
        blob: {
          url: `${MEMORY_BLOB_ORIGIN}/${key(save, "png")}`,
          createdOn: at,
          lastModified: at,
          etag: `"0x${saves.length + 1}"`,
          contentMd5: createHash("md5").update(content.png).digest("base64"),
        },
      };
      for (const kind of Object.keys(FILES) as FileKind[]) {
        const bytes = content[kind];
        if (bytes) files.set(key(save, kind), bytes);
      }
      saves.push(stored);
      return { save: stored, created: true };
    },
    fileUrl: (ref, kind) => `${MEMORY_BLOB_ORIGIN}/${key(ref, kind)}`,
    readFile: async (ref, kind) => files.get(key(ref, kind)) ?? null,
    getState: async (k) => state.get(k) ?? null,
    setState: async (k, value) => void state.set(k, value),
    async claim(k) {
      if (state.has(`claim:${k}`)) return false;
      state.set(`claim:${k}`, "1");
      return true;
    },
  };
}
