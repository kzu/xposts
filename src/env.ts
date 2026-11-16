import type { Env } from "./types";

/** The settings of this deployment, from environment variables. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const production = source.VERCEL_PROJECT_PRODUCTION_URL;
  return {
    PUBLIC_URL: (source.PUBLIC_URL ?? (production ? `https://${production}` : "http://localhost:3000")).replace(/\/+$/, ""),
    REPO_URL: source.REPO_URL ?? "https://github.com/kzu/xposts",
    X_BOT_HANDLE: source.X_BOT_HANDLE ?? "SaveXPosts",
    AZURE_STORAGE_CONNECTION_STRING: source.AZURE_STORAGE_CONNECTION_STRING,
    AUTH0_DOMAIN: source.AUTH0_DOMAIN,
    AUTH0_CLIENT_ID: source.AUTH0_CLIENT_ID,
    AUTH0_CLIENT_SECRET: source.AUTH0_CLIENT_SECRET,
    SESSION_SECRET: source.SESSION_SECRET,
    X_BEARER_TOKEN: source.X_BEARER_TOKEN,
    X_API_KEY: source.X_API_KEY,
    X_API_SECRET: source.X_API_SECRET,
    X_ACCESS_TOKEN: source.X_ACCESS_TOKEN,
    X_ACCESS_SECRET: source.X_ACCESS_SECRET,
    X_BOT_USER_ID: source.X_BOT_USER_ID,
    CRON_SECRET: source.CRON_SECRET,
  };
}
