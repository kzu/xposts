// The JSON API.

import { Hono } from "hono";

import type { Deps } from "./deps.js";
import { pollMentions } from "./mentions.js";
import { RENDER_OPTIONS } from "./render/xeet.js";
import { savePath, type AppEnv } from "./types.js";

export function createApi(deps: Deps): Hono<AppEnv> {
  const api = new Hono<AppEnv>();

  api.get("/api/verify/:sha256", async (c) => {
    const sha256 = c.req.param("sha256").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) return c.json({ error: "expected a hex SHA-256" }, 400);
    const save = await deps.store.findBySha256(sha256);
    if (!save) return c.json({ error: "the archive holds no image with this hash" }, 404);
    return c.json({ save, page: `${c.env.PUBLIC_URL}${savePath(save)}` });
  });

  /** What an independent verifier needs to know about this deployment. */
  api.get("/api/info", (c) =>
    c.json({ source: c.env.REPO_URL, renderer: { package: "@xeet/core", options: RENDER_OPTIONS } }),
  );

  /** Called on a schedule: answers the mentions of the bot account since the last call. */
  api.get("/api/cron/mentions", async (c) => {
    const secret = c.env.CRON_SECRET;
    if (!secret) return c.json({ error: "CRON_SECRET is not set" }, 503);
    if (c.req.header("authorization") !== `Bearer ${secret}`) return c.json({ error: "unauthorized" }, 401);
    return c.json(await pollMentions(c.env, deps));
  });

  return api;
}
