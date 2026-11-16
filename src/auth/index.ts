// Sign-in with Auth0 (authorization code flow with PKCE) and the session cookie.
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SignJWT, createLocalJWKSet, jwtVerify } from "jose";
import type { JSONWebKeySet } from "jose";

import type { AppEnv, Env, Session } from "../types.js";
import { notConfiguredPage, signInErrorPage } from "./pages.js";

export const SESSION_COOKIE = "xposts_session";
const LOGIN_COOKIE = "xposts_login";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_SECONDS = 10 * 60;

// Distinct audiences so a login-state token can never pass as a session.
const ISSUER = "xposts";
const SESSION_AUDIENCE = "xposts:session";
const LOGIN_AUDIENCE = "xposts:login";

const SETTINGS = ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "SESSION_SECRET"] as const;

export function missingSettings(env: Partial<Env>): string[] {
  return SETTINGS.filter((name) => !env[name]);
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** Secure cookies need https; on http://localhost they would never be sent back. */
function cookieSecure(env: Pick<Env, "PUBLIC_URL">): boolean {
  return env.PUBLIC_URL.startsWith("https://");
}

/** Accepts only paths of this site: no scheme, no host, no `//` or `/\` tricks. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  try {
    if (new URL(value, "http://same-origin.invalid").origin !== "http://same-origin.invalid") return "/";
  } catch {
    return "/";
  }
  return value;
}

export async function createSessionToken(env: Pick<Env, "SESSION_SECRET">, session: Session): Promise<string> {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set");
  return new SignJWT({ name: session.name, ...(session.picture ? { picture: session.picture } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.sub)
    .setIssuer(ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_SECONDS}s`)
    .sign(secretKey(env.SESSION_SECRET));
}

/** The session a cookie value holds, or null when it is missing, forged or expired. */
export async function readSessionToken(
  env: Pick<Env, "SESSION_SECRET">,
  token: string | undefined,
): Promise<Session | null> {
  if (!token || !env.SESSION_SECRET) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(env.SESSION_SECRET), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: SESSION_AUDIENCE,
    });
    if (!payload.sub || typeof payload.name !== "string") return null;
    return {
      sub: payload.sub,
      name: payload.name,
      ...(typeof payload.picture === "string" ? { picture: payload.picture } : {}),
    };
  } catch {
    return null;
  }
}

export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("session", await readSessionToken(c.env, getCookie(c, SESSION_COOKIE)));
  await next();
};

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("session")) {
    const url = new URL(c.req.url);
    return c.redirect(`/auth/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
  }
  await next();
};

interface LoginState {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
}

function auth0Domain(env: Env): string {
  return (env.AUTH0_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * The auth routes. `fetchImpl` carries every call to Auth0 (token endpoint and
 * signing keys) so tests can answer them.
 */
export function createAuth(options: { fetchImpl?: typeof fetch } = {}): Hono<AppEnv> {
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const app = new Hono<AppEnv>();

  app.get("/auth/login", async (c) => {
    const missing = missingSettings(c.env);
    if (missing.length > 0) return notConfiguredPage(c, missing);

    const login: LoginState = {
      state: randomToken(),
      verifier: randomToken(),
      nonce: randomToken(),
      returnTo: safeReturnTo(c.req.query("returnTo")),
    };
    const cookie = await new SignJWT({ ...login })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(LOGIN_AUDIENCE)
      .setExpirationTime(`${LOGIN_SECONDS}s`)
      .sign(secretKey(c.env.SESSION_SECRET!));
    setCookie(c, LOGIN_COOKIE, cookie, {
      httpOnly: true,
      secure: cookieSecure(c.env),
      sameSite: "Lax",
      path: "/auth",
      maxAge: LOGIN_SECONDS,
    });

    const url = new URL(`https://${auth0Domain(c.env)}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: c.env.AUTH0_CLIENT_ID!,
      redirect_uri: `${c.env.PUBLIC_URL}/auth/callback`,
      scope: "openid profile",
      state: login.state,
      nonce: login.nonce,
      code_challenge: await pkceChallenge(login.verifier),
      code_challenge_method: "S256",
    }).toString();
    return c.redirect(url.toString());
  });

  app.get("/auth/callback", async (c) => {
    const missing = missingSettings(c.env);
    if (missing.length > 0) return notConfiguredPage(c, missing);

    const cookie = getCookie(c, LOGIN_COOKIE);
    deleteCookie(c, LOGIN_COOKIE, { path: "/auth" });

    const fail = (message: string, status: 400 | 502 = 400) => signInErrorPage(c, message, status);

    const providerError = c.req.query("error");
    if (providerError) return fail(`Auth0 refused the sign-in: ${c.req.query("error_description") ?? providerError}.`);

    let login: LoginState;
    try {
      if (!cookie) throw new Error("no login cookie");
      const { payload } = await jwtVerify(cookie, secretKey(c.env.SESSION_SECRET!), {
        algorithms: ["HS256"],
        issuer: ISSUER,
        audience: LOGIN_AUDIENCE,
      });
      login = payload as unknown as LoginState;
    } catch {
      return fail("The sign-in attempt expired or did not start here. Please try again.");
    }

    const code = c.req.query("code");
    if (!code || c.req.query("state") !== login.state) {
      return fail("The sign-in response did not match the attempt that started it. Please try again.");
    }

    const domain = auth0Domain(c.env);
    const tokenResponse = await fetchImpl(`https://${domain}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: c.env.AUTH0_CLIENT_ID!,
        client_secret: c.env.AUTH0_CLIENT_SECRET!,
        code,
        code_verifier: login.verifier,
        redirect_uri: `${c.env.PUBLIC_URL}/auth/callback`,
      }),
    });
    if (!tokenResponse.ok) {
      return fail(`Auth0 did not accept the sign-in (token endpoint answered ${tokenResponse.status}).`, 502);
    }
    const tokens = (await tokenResponse.json()) as { id_token?: string };
    if (!tokens.id_token) return fail("Auth0 answered without an ID token.", 502);

    // Fetched per sign-in: sign-ins are rare, and key rotation then needs no cache handling.
    const jwksResponse = await fetchImpl(`https://${domain}/.well-known/jwks.json`);
    if (!jwksResponse.ok) return fail(`Auth0 signing keys are unavailable (answered ${jwksResponse.status}).`, 502);
    const jwks = createLocalJWKSet((await jwksResponse.json()) as JSONWebKeySet);

    let session: Session;
    try {
      const { payload } = await jwtVerify(tokens.id_token, jwks, {
        algorithms: ["RS256"],
        issuer: `https://${domain}/`,
        audience: c.env.AUTH0_CLIENT_ID!,
      });
      if (payload.nonce !== login.nonce) throw new Error("nonce mismatch");
      if (!payload.sub) throw new Error("no subject");
      const name = [payload.name, payload.nickname, payload.email].find((v) => typeof v === "string" && v);
      session = {
        sub: payload.sub,
        name: (name as string | undefined) ?? payload.sub,
        ...(typeof payload.picture === "string" ? { picture: payload.picture } : {}),
      };
    } catch (error) {
      return fail(`The ID token from Auth0 is not valid: ${error instanceof Error ? error.message : String(error)}.`);
    }

    setCookie(c, SESSION_COOKIE, await createSessionToken(c.env, session), {
      httpOnly: true,
      secure: cookieSecure(c.env),
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_SECONDS,
    });
    return c.redirect(safeReturnTo(login.returnTo));
  });

  app.get("/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    if (missingSettings(c.env).length > 0) return c.redirect("/");
    const url = new URL(`https://${auth0Domain(c.env)}/v2/logout`);
    url.search = new URLSearchParams({ client_id: c.env.AUTH0_CLIENT_ID!, returnTo: c.env.PUBLIC_URL }).toString();
    return c.redirect(url.toString());
  });

  return app;
}

export const auth = createAuth();
