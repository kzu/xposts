import { ARTIFACTS, captureKey, type Artifact, type CaptureRef } from "./types";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * How each stored file is served. The archived x.com page is served as plain
 * text: it is evidence, and must never run as HTML on the archive's origin.
 */
export const CONTENT_TYPES: Record<string, string> = {
  [ARTIFACTS.png]: "image/png",
  [ARTIFACTS.xApi]: "application/json",
  [ARTIFACTS.xApiHeaders]: "application/json",
  [ARTIFACTS.xPage]: "text/plain; charset=utf-8",
  [ARTIFACTS.xeetInput]: "application/json",
  [ARTIFACTS.manifest]: "application/json",
};

/** Stores one file of a capture and returns its manifest entry. */
export async function putArtifact(
  bucket: R2Bucket,
  ref: CaptureRef,
  name: string,
  bytes: Uint8Array,
): Promise<Artifact> {
  const contentType = CONTENT_TYPES[name];
  if (!contentType) throw new Error(`"${name}" is not a capture file`);
  const sha256 = await sha256Hex(bytes);
  await bucket.put(captureKey(ref, name), bytes, { httpMetadata: { contentType }, sha256 });
  return { name, contentType, bytes: bytes.byteLength, sha256 };
}
