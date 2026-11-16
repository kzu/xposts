// Shared contracts. Modules depend on these types, not on each other.

/** Settings, read from the process environment (src/env.ts). */
export interface Env {
  /** Origin the archive is served from, without a trailing slash. */
  PUBLIC_URL: string;
  /** Where the source code of this deployment lives. */
  REPO_URL: string;

  // Azure Blob Storage: the only store. Saves live in a container anyone can read and list.
  AZURE_STORAGE_CONNECTION_STRING?: string;

  // Auth0 (regular web application). Sign-in is required to submit a post.
  AUTH0_DOMAIN?: string;
  AUTH0_CLIENT_ID?: string;
  AUTH0_CLIENT_SECRET?: string;
  /** Signs the session cookie. */
  SESSION_SECRET?: string;

  // X API. The bearer token reads posts; the OAuth 1.0a user tokens belong to
  // the bot account and are used to read its mentions and to reply.
  X_BEARER_TOKEN?: string;
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_SECRET?: string;
  /** Numeric user id of the bot account. */
  X_BOT_USER_ID?: string;
  /** Handle of the bot account, without "@". */
  X_BOT_HANDLE: string;

  /** What the scheduler that polls mentions must present as a bearer token. */
  CRON_SECRET?: string;
}

/** A saved post is identified by its author's handle, lower-cased, and the post id. */
export interface SaveRef {
  username: string;
  postId: string;
}

/**
 * What Azure Blob Storage itself states about the stored image. The archive
 * cannot set these values: they are the proof of when the save was made.
 */
export interface BlobProof {
  /** Public URL of the image blob. Anyone can `curl -I` it and read the same values. */
  url: string;
  /** `x-ms-creation-time`: when Azure created the blob. */
  createdOn: string;
  /** `Last-Modified`: equal to `createdOn` for a blob that was never rewritten. */
  lastModified: string;
  etag: string;
  /** `Content-MD5` of the image, base64, computed by Azure on upload. */
  contentMd5: string | null;
}

/** A saved post, as lists and pages show it. Stored as the metadata of the image blob. */
export interface Save extends SaveRef {
  /** The author's handle as X writes it. */
  handle: string;
  authorName: string | null;
  /** The start of the text; the whole text is in the record. */
  excerpt: string;
  postedAt: string | null;
  /** When the archive took the save, by its own clock. */
  capturedAt: string;
  /** Hex SHA-256 of the image. */
  pngSha256: string;
  /** Hex SHA-256 of record.json. */
  recordSha256: string;
  /** Size of the image in pixels. */
  width: number;
  height: number;
  source: "web" | "mention";
  blob: BlobProof;
}

/** The files of a save, next to each other in the container: `<username>/<post id><suffix>`. */
export const FILES = {
  /** The rendered post. */
  png: ".png",
  /** What is known about the save: the whole text, hashes, what X stated. */
  record: ".json",
  /** The X API response body, byte for byte. */
  xApi: ".x-api.json",
  /** The exact renderer input: rendering it again reproduces the image. */
  xeetInput: ".xeet-input.json",
} as const;

export type FileKind = keyof typeof FILES;

/** The record.json of a save. */
export interface SaveRecord {
  schema: "xposts/save/v1";
  postId: string;
  url: string;
  capturedAt: string;
  post: {
    handle: string;
    authorName: string | null;
    text: string;
    postedAt: string | null;
  };
  renderer: {
    package: string;
    version: string;
    /** The x.com web app version whose rules the renderer carries. */
    upstream: string;
    options: Record<string, unknown>;
  };
  /** Where the rendered text came from, and whether both sources agree. */
  text: {
    source: "x-api" | "x-page";
    /** Null when only one source was available. */
    sourcesMatch: boolean | null;
  };
  /** What X itself said about the post at capture time. */
  fingerprint: Fingerprint;
  /** Hex SHA-256 of the other files of the save. */
  files: { png: string; xeetInput: string; xApi?: string };
  warnings: string[];
}

export interface Fingerprint {
  /** Creation time encoded in the post id (a snowflake), which the author cannot choose. Null for ids older than snowflakes. */
  snowflakeTime: string | null;
  /** `created_at` as the X API reported it. */
  apiCreatedAt: string | null;
  /** Whether the two agree to the second. */
  timeConsistent: boolean | null;
  /** `edit_history_tweet_ids` from the API: more than one id means the post was edited. */
  editHistory: string[] | null;
  /** Response headers of the X API request that identify it on X's side. */
  apiHeaders: Record<string, string>;
  /** The x.com web app version that served the page. */
  pageAppVersion: string | null;
}

/** A session established through Auth0. */
export interface Session {
  sub: string;
  name: string;
  picture?: string;
}

/** The Hono environment every route shares. `session` is set by the auth middleware. */
export interface AppEnv {
  Bindings: Env;
  Variables: { session: Session | null };
}

/** The page of a save. */
export function savePath(ref: SaveRef): string {
  return `/${ref.username}/${ref.postId}`;
}

/** The address that redirects to the image itself. */
export function shortPath(ref: SaveRef): string {
  return `/s/${ref.username}/${ref.postId}`;
}
