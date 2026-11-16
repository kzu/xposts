import { Hono } from "hono";

import { createApi } from "./api.js";
import { auth, sessionMiddleware } from "./auth/index.js";
import type { Deps } from "./deps.js";
import type { AppEnv } from "./types.js";
import { createWeb, notFound } from "./web/index.js";

export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(sessionMiddleware);
  app.route("/", auth);
  app.route("/", createApi(deps));
  app.route("/", createWeb(deps));
  app.notFound(notFound);
  return app;
}
