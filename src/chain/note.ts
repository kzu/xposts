// The transaction note of an anchor. This is a public format: anyone can list
// the archive account's transactions and parse their notes without this code.
//
// It follows ARC-2 (<dapp-name>:<format><data>): the prefix "xposts/v1:j"
// followed by compact JSON, with the keys in this order:
//
//   p  the X post id (decimal string)
//   t  the capture time, UTC, YYYYMMDDHHmmss
//   i  SHA-256 of the capture's post.png, 64 lowercase hex chars
//   m  SHA-256 of the capture's manifest.json, 64 lowercase hex chars
//   u  the public URL of the capture
//
// Example: xposts/v1:j{"p":"20","t":"20261116042737","i":"…","m":"…","u":"https://…/p/20/20261116042737"}
//
// The v1 key set is closed: a note with other keys is not a v1 note. Anything
// new goes into a v2 prefix.

import type { AnchorRecord } from "../types";

export const NOTE_PREFIX = "xposts/v1:j";
/** Algorand's limit on the note field. */
export const MAX_NOTE_BYTES = 1024;

const KEYS = ["p", "t", "i", "m", "u"] as const;
const HASH = /^[0-9a-f]{64}$/;

/** Why a record cannot be anchored, or null when it can. */
function problem(record: AnchorRecord): string | null {
  if (typeof record.postId !== "string" || !/^\d{1,20}$/.test(record.postId)) return "postId must be a decimal post id";
  if (typeof record.ts !== "string" || !/^\d{14}$/.test(record.ts)) return "ts must be YYYYMMDDHHmmss";
  if (typeof record.png !== "string" || !HASH.test(record.png)) return "png must be 64 lowercase hex chars";
  if (typeof record.manifest !== "string" || !HASH.test(record.manifest)) return "manifest must be 64 lowercase hex chars";
  if (typeof record.url !== "string" || !/^https?:\/\/\S+$/.test(record.url)) return "url must be an http(s) URL";
  return null;
}

export function encodeNote(record: AnchorRecord): Uint8Array {
  const invalid = problem(record);
  if (invalid) throw new Error(`Cannot anchor this record: ${invalid}.`);
  const json = JSON.stringify({ p: record.postId, t: record.ts, i: record.png, m: record.manifest, u: record.url });
  const note = new TextEncoder().encode(NOTE_PREFIX + json);
  if (note.length > MAX_NOTE_BYTES) {
    throw new Error(`The anchor note has ${note.length} bytes; Algorand allows ${MAX_NOTE_BYTES}. Shorten the URL.`);
  }
  return note;
}

/** The record of an xposts/v1 note, or null for anything else. */
export function decodeNote(note: Uint8Array): AnchorRecord | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(note);
  } catch {
    return null;
  }
  if (!text.startsWith(NOTE_PREFIX)) return null;
  let data: unknown;
  try {
    data = JSON.parse(text.slice(NOTE_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== KEYS.length || !KEYS.every((key) => keys.includes(key))) return null;
  const record = { postId: fields.p, ts: fields.t, png: fields.i, manifest: fields.m, url: fields.u } as AnchorRecord;
  return problem(record) ? null : record;
}
