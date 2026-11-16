// The store on Azure Blob Storage.
//
// A save is a few blobs next to each other in a container anyone can read and
// list: `<username>/<post id>.png` and its sidecar files. The image blob is
// the save: its metadata describes it, its index tags find it by post id or
// by hash, and the properties Azure sets on it (creation time, Last-Modified,
// ETag, Content-MD5) date it. A second container, private, holds the
// archive's own small state.

import {
  BlobServiceClient,
  type BlobGetPropertiesResponse,
  type BlobItem,
  type ContainerClient,
} from "@azure/storage-blob";

import { normalizeUsername, type NewSave, type SaveFiles, type Store } from "./store";
import { FILES, type BlobProof, type FileKind, type Save, type SaveRef } from "./types";

export const SAVES_CONTAINER = "saves";
export const STATE_CONTAINER = "state";

/** How many of the latest saves the home page can show. */
const RECENT_LIMIT = 48;
const RECENT_BLOB = "recent.json";

/** Blob metadata travels in HTTP headers: text is percent-encoded to keep it ASCII. */
const TEXT_KEYS = new Set(["handle", "authorname", "excerpt"]);

function toMetadata(save: NewSave): Record<string, string> {
  const values: Record<string, string> = {
    postid: save.postId,
    handle: save.handle,
    authorname: save.authorName ?? "",
    excerpt: save.excerpt,
    postedat: save.postedAt ?? "",
    capturedat: save.capturedAt,
    sha256: save.pngSha256,
    recordsha256: save.recordSha256,
    width: String(save.width),
    height: String(save.height),
    source: save.source,
  };
  for (const key of TEXT_KEYS) values[key] = encodeURIComponent(values[key]!);
  return values;
}

function fromBlob(username: string, metadata: Record<string, string> | undefined, blob: BlobProof): Save | null {
  // Azure returns metadata keys in the case they were written; list and get agree on lower case here.
  const raw = metadata ?? {};
  const read = (key: string) => {
    const value = raw[key] ?? "";
    return TEXT_KEYS.has(key) ? decodeURIComponent(value) : value;
  };
  if (!read("postid") || !read("sha256")) return null;
  return {
    username,
    postId: read("postid"),
    handle: read("handle") || username,
    authorName: read("authorname") || null,
    excerpt: read("excerpt"),
    postedAt: read("postedat") || null,
    capturedAt: read("capturedat"),
    pngSha256: read("sha256"),
    recordSha256: read("recordsha256"),
    width: Number(read("width")),
    height: Number(read("height")),
    source: read("source") === "mention" ? "mention" : "web",
    blob,
  };
}

function proof(
  url: string,
  properties: Pick<BlobGetPropertiesResponse, "createdOn" | "lastModified" | "etag" | "contentMD5"> | BlobItem["properties"],
): BlobProof {
  if (!properties.createdOn || !properties.lastModified || !properties.etag) {
    throw new Error(`Azure returned no creation time, Last-Modified or ETag for ${url}`);
  }
  return {
    url,
    createdOn: properties.createdOn.toISOString(),
    lastModified: properties.lastModified.toISOString(),
    // Listing returns the ETag bare, a blob request quoted as in the HTTP header: keep the header form.
    etag: properties.etag.startsWith('"') ? properties.etag : `"${properties.etag}"`,
    contentMd5: properties.contentMD5 ? Buffer.from(properties.contentMD5).toString("base64") : null,
  };
}

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "statusCode" in error
    ? (error as { statusCode?: number }).statusCode
    : undefined;
}

const JSON_HEADERS = { blobContentType: "application/json" };
/** A save never changes, so its files can be cached for good. */
const IMMUTABLE = "public, max-age=31536000, immutable";

export function azureStore(connectionString: string | undefined): Store {
  let clients: { service: BlobServiceClient; saves: ContainerClient; state: ContainerClient } | undefined;
  // Created on first use, so a deployment without storage still serves its pages and says what is missing.
  function azure() {
    if (clients) return clients;
    if (!connectionString) throw new Error("AZURE_STORAGE_CONNECTION_STRING is not set: the archive has no storage");
    const service = BlobServiceClient.fromConnectionString(connectionString);
    clients = {
      service,
      saves: service.getContainerClient(SAVES_CONTAINER),
      state: service.getContainerClient(STATE_CONTAINER),
    };
    return clients;
  }

  const blobName = (ref: SaveRef, kind: FileKind) => `${normalizeUsername(ref.username)}/${ref.postId}${FILES[kind]}`;

  async function getSave(ref: SaveRef): Promise<Save | null> {
    const username = normalizeUsername(ref.username);
    const blob = azure().saves.getBlockBlobClient(blobName(ref, "png"));
    try {
      const properties = await blob.getProperties();
      return fromBlob(username, properties.metadata, proof(blob.url, properties));
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw error;
    }
  }

  /** The save whose image blob carries this index tag. Tags are indexed a few seconds after a save. */
  async function findByTag(tag: "postid" | "sha256", value: string): Promise<Save | null> {
    if (!/^[0-9a-f]+$/.test(value)) return null;
    const query = `@container='${SAVES_CONTAINER}' AND "${tag}"='${value}'`;
    for await (const found of azure().service.findBlobsByTags(query)) {
      const [username, file] = found.name.split("/");
      if (username && file?.endsWith(FILES.png)) {
        return getSave({ username, postId: file.slice(0, -FILES.png.length) });
      }
    }
    return null;
  }

  async function readState(name: string): Promise<{ text: string; etag: string } | null> {
    try {
      const blob = azure().state.getBlockBlobClient(name);
      const [buffer, properties] = await Promise.all([blob.downloadToBuffer(), blob.getProperties()]);
      return { text: buffer.toString("utf8"), etag: properties.etag! };
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw error;
    }
  }

  /** Puts a save at the head of the home page's list. Retries when another save got there first. */
  async function addRecent(save: Save): Promise<void> {
    const blob = azure().state.getBlockBlobClient(RECENT_BLOB);
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await readState(RECENT_BLOB);
      const list = current ? (JSON.parse(current.text) as Save[]) : [];
      const next = JSON.stringify([save, ...list.filter((s) => s.postId !== save.postId)].slice(0, RECENT_LIMIT));
      try {
        await blob.upload(next, Buffer.byteLength(next), {
          blobHTTPHeaders: JSON_HEADERS,
          conditions: current ? { ifMatch: current.etag } : { ifNoneMatch: "*" },
        });
        return;
      } catch (error) {
        const status = statusOf(error);
        if (status !== 409 && status !== 412) throw error;
      }
    }
    throw new Error("the list of recent saves kept changing; gave up updating it");
  }

  return {
    getSave,
    findByPostId: (postId) => findByTag("postid", postId),
    findBySha256: (sha256) => findByTag("sha256", sha256.toLowerCase()),

    async listSaves(username) {
      const prefix = `${normalizeUsername(username)}/`;
      const { saves } = azure();
      const found: Save[] = [];
      for await (const item of saves.listBlobsFlat({ prefix, includeMetadata: true })) {
        if (!item.name.endsWith(FILES.png)) continue;
        const save = fromBlob(
          normalizeUsername(username),
          item.metadata,
          proof(saves.getBlockBlobClient(item.name).url, item.properties),
        );
        if (save) found.push(save);
      }
      // Post ids grow with time: the newest post first.
      return found.sort((a, b) => (BigInt(a.postId) < BigInt(b.postId) ? 1 : -1));
    },

    async recentSaves(limit) {
      const current = await readState(RECENT_BLOB);
      return current ? (JSON.parse(current.text) as Save[]).slice(0, limit) : [];
    },

    async createSave(save: NewSave, files: SaveFiles) {
      const existing = await getSave(save);
      if (existing) return { save: existing, created: false };

      const { saves } = azure();
      // Sidecars first: the image is written last, so an image always has its files.
      const sidecars: [FileKind, Uint8Array | undefined][] = [
        ["record", files.record],
        ["xeetInput", files.xeetInput],
        ["xApi", files.xApi],
      ];
      for (const [kind, bytes] of sidecars) {
        if (!bytes) continue;
        await saves.getBlockBlobClient(blobName(save, kind)).upload(bytes, bytes.byteLength, {
          blobHTTPHeaders: { ...JSON_HEADERS, blobCacheControl: IMMUTABLE },
        });
      }
      try {
        await saves.getBlockBlobClient(blobName(save, "png")).upload(files.png, files.png.byteLength, {
          blobHTTPHeaders: { blobContentType: "image/png", blobCacheControl: IMMUTABLE },
          metadata: toMetadata(save),
          tags: { postid: save.postId, sha256: save.pngSha256 },
          // Never replaces an image: the first save of a post stands.
          conditions: { ifNoneMatch: "*" },
        });
      } catch (error) {
        if (statusOf(error) !== 409) throw error;
        const winner = await getSave(save);
        if (!winner) throw error;
        return { save: winner, created: false };
      }
      const stored = await getSave(save);
      if (!stored) throw new Error(`the save of post ${save.postId} is missing right after it was stored`);
      await addRecent(stored);
      return { save: stored, created: true };
    },

    fileUrl: (ref, kind) => azure().saves.getBlockBlobClient(blobName(ref, kind)).url,

    async readFile(ref, kind) {
      try {
        return new Uint8Array(await azure().saves.getBlockBlobClient(blobName(ref, kind)).downloadToBuffer());
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
      }
    },

    async getState(key) {
      return (await readState(`kv/${key}`))?.text ?? null;
    },

    async setState(key, value) {
      await azure().state.getBlockBlobClient(`kv/${key}`).upload(value, Buffer.byteLength(value));
    },

    async claim(key) {
      try {
        await azure().state.getBlockBlobClient(`claims/${key}`).upload("", 0, { conditions: { ifNoneMatch: "*" } });
        return true;
      } catch (error) {
        if (statusOf(error) === 409) return false;
        throw error;
      }
    },
  };
}
