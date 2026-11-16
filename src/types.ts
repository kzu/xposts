// Shared contracts. Modules depend on these types, not on each other.

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ARCHIVE_QUEUE: Queue<ArchiveJob>;

  /** Origin the archive is served from, without a trailing slash. */
  PUBLIC_URL: string;

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

  // Algorand. Without a mnemonic, captures are stored but not anchored.
  ALGORAND_NETWORK: AlgorandNetwork;
  ALGORAND_MNEMONIC?: string;
  ALGOD_URL?: string;
  INDEXER_URL?: string;
}

export type AlgorandNetwork = "mainnet" | "testnet";

/** A capture is identified by the post and the UTC time it was taken (YYYYMMDDHHmmss). */
export interface CaptureRef {
  postId: string;
  ts: string;
}

export interface ArchiveJob extends CaptureRef {
  /** Set when a mention asked for the capture: the bot replies to it when done. */
  mention?: { id: string; authorHandle: string };
}

export type CaptureStatus = "pending" | "done" | "failed";

export interface Capture extends CaptureRef {
  status: CaptureStatus;
  error: string | null;
  source: "web" | "mention";
  requestedBy: string;
  mentionId: string | null;
  replyId: string | null;
  authorHandle: string | null;
  authorName: string | null;
  text: string | null;
  postedAt: string | null;
  capturedAt: string | null;
  pngSha256: string | null;
  manifestSha256: string | null;
  width: number | null;
  height: number | null;
  anchorNetwork: AlgorandNetwork | null;
  anchorTxid: string | null;
  anchorRound: number | null;
  createdAt: string;
}

/** One stored file of a capture. */
export interface Artifact {
  /** File name under the capture's R2 prefix, e.g. "post.png". */
  name: string;
  contentType: string;
  bytes: number;
  sha256: string;
}

export const ARTIFACTS = {
  /** The rendered post. */
  png: "post.png",
  /** The X API response body, byte for byte. */
  xApi: "x-api.json",
  /** The X API response headers of that request. */
  xApiHeaders: "x-api-headers.json",
  /** The x.com page the renderer resolved the post from, byte for byte. */
  xPage: "x-page.html",
  /** The exact renderer input: re-rendering it reproduces the PNG. */
  xeetInput: "xeet-input.json",
  /** Hashes of everything above, plus what is known about the capture. */
  manifest: "manifest.json",
} as const;

/** What a capture's manifest.json holds. Its SHA-256 is what goes on chain. */
export interface Manifest {
  schema: "xposts/manifest/v1";
  postId: string;
  ts: string;
  url: string;
  capturedAt: string;
  post: {
    authorHandle: string | null;
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
  artifacts: Artifact[];
  warnings: string[];
}

export interface Fingerprint {
  /** Creation time encoded in the post id (a snowflake), which the author cannot choose. */
  snowflakeTime: string;
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

/** What is written to the Algorand transaction note. */
export interface AnchorRecord {
  postId: string;
  ts: string;
  /** Hex SHA-256 of post.png. */
  png: string;
  /** Hex SHA-256 of manifest.json. */
  manifest: string;
  /** Public URL of the capture. */
  url: string;
}

export interface Anchor {
  network: AlgorandNetwork;
  txId: string;
  round: number;
}

/** A session established through Auth0. */
export interface Session {
  sub: string;
  name: string;
  picture?: string;
}

export function captureKey(ref: CaptureRef, name: string): string {
  return `captures/${ref.postId}/${ref.ts}/${name}`;
}

export function captureUrl(env: Pick<Env, "PUBLIC_URL">, ref: CaptureRef): string {
  return `${env.PUBLIC_URL}/p/${ref.postId}/${ref.ts}`;
}

/** The Hono environment every route shares. `session` is set by the auth middleware. */
export interface AppEnv {
  Bindings: Env;
  Variables: { session: Session | null };
}
