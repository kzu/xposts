import { Hono } from "hono";

import { createApi } from "./api";
import { auth, sessionMiddleware } from "./auth";
import type { Deps } from "./deps";
import type { AppEnv } from "./types";
import { createWeb, notFound } from "./web";

export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(sessionMiddleware);
  app.route("/", auth);
  app.route("/", createApi(deps));
  app.route("/", createWeb(deps));
  app.notFound(notFound);
  return app;
}
