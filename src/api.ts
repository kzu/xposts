// The stored files of a capture, and the JSON API.

import { Hono } from "hono";

import { anchorAddress, explorerUrl } from "./chain";
import { findByHash, getCapture } from "./db";
import { RENDER_OPTIONS } from "./render/xeet";
import { XEET_VERSION } from "./render/generated/xeet-wasm.js";
import { CONTENT_TYPES } from "./storage";
import { captureKey, captureUrl, type AppEnv, type Capture } from "./types";

export const api = new Hono<AppEnv>();

/** A capture as the public sees it: without who asked for it. */
function publicCapture(capture: Capture): Omit<Capture, "requestedBy"> {
  const { requestedBy: _requestedBy, ...rest } = capture;
  return rest;
}

const POST_ID = /^\d{1,20}$/;
const TS = /^\d{14}$/;

api.get("/p/:postId/:ts/:file", async (c) => {
  const { postId, ts, file } = c.req.param();
  if (!POST_ID.test(postId) || !TS.test(ts) || !CONTENT_TYPES[file]) return c.notFound();
  const object = await c.env.BUCKET.get(captureKey({ postId, ts }, file));
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: {
      "content-type": CONTENT_TYPES[file],
      // A capture never changes once stored.
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "access-control-allow-origin": "*",
      etag: object.httpEtag,
    },
  });
});

api.get("/api/captures/:postId/:ts", async (c) => {
  const { postId, ts } = c.req.param();
  if (!POST_ID.test(postId) || !TS.test(ts)) return c.notFound();
  const capture = await getCapture(c.env.DB, { postId, ts });
  if (!capture) return c.json({ error: "no such capture" }, 404);
  return c.json(publicCapture(capture));
});

api.get("/api/verify/:sha256", async (c) => {
  const sha256 = c.req.param("sha256").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) return c.json({ error: "expected a hex SHA-256" }, 400);
  const capture = await findByHash(c.env.DB, sha256);
  if (!capture) return c.json({ error: "the archive holds no capture with this hash" }, 404);
  return c.json({
    capture: publicCapture(capture),
    url: captureUrl(c.env, capture),
    anchor:
      capture.anchorTxid && capture.anchorNetwork
        ? {
            network: capture.anchorNetwork,
            txId: capture.anchorTxid,
            round: capture.anchorRound,
            explorerUrl: explorerUrl(capture.anchorNetwork, capture.anchorTxid),
          }
        : null,
  });
});

/** What an independent verifier needs to know about this deployment. */
api.get("/api/info", async (c) =>
  c.json({
    source: c.env.REPO_URL,
    renderer: { package: "@xeet/core", version: XEET_VERSION, options: RENDER_OPTIONS },
    anchor: { network: c.env.ALGORAND_NETWORK, address: await anchorAddress(c.env) },
  }),
);
