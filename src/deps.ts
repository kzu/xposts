// What the routes are built from, so tests can supply their own.

import type { Store } from "./store.js";
import type { Save } from "./types.js";
import type { PostRef } from "./x/ref.js";

export interface SaveRequest {
  post: PostRef;
  source: Save["source"];
  /** Who asked: an Auth0 subject, or `x:<user id>` for a mention. Kept private. */
  requestedBy: string;
}

/** A save that cannot be made. `retryable` says whether trying again can help. */
export class CaptureError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

export interface Deps {
  store: Store;
  /**
   * Saves a post: reads it from X, renders it and stores it. A post that is
   * already saved is returned as it is (`created: false`), never rendered again.
   * Throws `CaptureError`.
   */
  save(request: SaveRequest): Promise<{ save: Save; created: boolean }>;
}
