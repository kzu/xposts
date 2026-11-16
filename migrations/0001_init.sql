-- One row per capture of a post. A post can be captured many times; `ts` is the
-- UTC capture time as YYYYMMDDHHmmss, so (post_id, ts) reads like a Wayback URL.
CREATE TABLE captures (
  post_id         TEXT NOT NULL,
  ts              TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed
  error           TEXT,
  source          TEXT NOT NULL,                   -- web | mention
  requested_by    TEXT NOT NULL,                   -- auth0 subject, or x:<user id>
  mention_id      TEXT,                            -- the mention that asked for it
  reply_id        TEXT,                            -- the bot's reply to that mention
  author_handle   TEXT,
  author_name     TEXT,
  text            TEXT,
  posted_at       TEXT,
  captured_at     TEXT,
  png_sha256      TEXT,
  manifest_sha256 TEXT,
  width           INTEGER,
  height          INTEGER,
  anchor_network  TEXT,
  anchor_txid     TEXT,
  anchor_round    INTEGER,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (post_id, ts)
);

CREATE INDEX captures_png_sha256 ON captures (png_sha256);
CREATE INDEX captures_manifest_sha256 ON captures (manifest_sha256);
CREATE INDEX captures_created_at ON captures (created_at DESC);
CREATE INDEX captures_author ON captures (author_handle, created_at DESC);

-- Small durable values, such as the id of the last mention handled.
CREATE TABLE state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
