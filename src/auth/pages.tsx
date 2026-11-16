import type { Context } from "hono";

import type { AppEnv } from "../types.js";
import { page } from "../web/layout.js";

export function notConfiguredPage(c: Context<AppEnv>, missing: string[]) {
  return page(
    c,
    { title: "Sign-in is not configured", status: 503 },
    <>
      <h1>Sign-in is not configured</h1>
      <p>This deployment has no Auth0 sign-in yet. These settings are missing:</p>
      <ul>
        {missing.map((name) => (
          <li>
            <code>{name}</code>
          </li>
        ))}
      </ul>
      <p>
        <a href="/">Back to the archive</a>
      </p>
    </>,
  );
}

export function signInErrorPage(c: Context<AppEnv>, message: string, status: 400 | 502) {
  return page(
    c,
    { title: "Sign-in failed", status },
    <>
      <h1>Sign-in failed</h1>
      <p>{message}</p>
      <p>
        <a href="/auth/login">Try again</a>
      </p>
    </>,
  );
}
