import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import { SESSION_COOKIE, createAuth, createSessionToken, readSessionToken, requireSession, safeReturnTo, sessionMiddleware } from "../src/auth";
import type { AppEnv, Env } from "../src/types";

const DOMAIN = "tenant.example.auth0.com";
const testEnv: Env = {
  PUBLIC_URL: "https://xposts.test",
  REPO_URL: "https://github.com/example/xposts",
  X_BOT_HANDLE: "SaveXPosts",
  AUTH0_DOMAIN: DOMAIN,
  AUTH0_CLIENT_ID: "client-1",
  AUTH0_CLIENT_SECRET: "client-secret",
  SESSION_SECRET: "a-long-random-secret-for-tests-only",
};

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };

async function idToken(claims: Record<string, unknown>, options: { audience?: string } = {}) {
  return new SignJWT({ name: "Ada Lovelace", picture: "https://img.test/ada.png", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject("auth0|ada")
    .setIssuer(`https://${DOMAIN}/`)
    .setAudience(options.audience ?? "client-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function makeApp(fetchImpl: typeof fetch) {
  const app = new Hono<AppEnv>();
  app.use("*", sessionMiddleware);
  app.route("/", createAuth({ fetchImpl }));
  app.get("/whoami", (c) => c.json(c.get("session")));
  app.get("/private", requireSession, (c) => c.text("secret"));
  return app;
}

/** Name and value of every cookie a response sets. */
function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .filter((pair) => !pair!.endsWith("="))
    .join("; ");
}

describe("session cookie", () => {
  it("round-trips a session", async () => {
    const token = await createSessionToken(testEnv, { sub: "auth0|1", name: "Ada", picture: "https://img.test/a.png" });
    expect(await readSessionToken(testEnv, token)).toEqual({ sub: "auth0|1", name: "Ada", picture: "https://img.test/a.png" });
  });

  it("rejects a tampered token, another secret and garbage", async () => {
    const token = await createSessionToken(testEnv, { sub: "auth0|1", name: "Ada" });
    const [header, payload, signature] = token.split(".");
    const forgedPayload = btoa(JSON.stringify({ sub: "auth0|admin", name: "Mallory", iss: "xposts", aud: "xposts:session" }))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(await readSessionToken(testEnv, `${header}.${forgedPayload}.${signature}`)).toBeNull();
    expect(await readSessionToken(testEnv, `${header}.${payload}.${signature!.slice(0, -2)}AA`)).toBeNull();
    expect(await readSessionToken({ SESSION_SECRET: "another-secret-entirely" }, token)).toBeNull();
    expect(await readSessionToken(testEnv, "nonsense")).toBeNull();
    expect(await readSessionToken(testEnv, undefined)).toBeNull();
  });

  it("is read by the middleware, and requireSession redirects without one", async () => {
    const app = makeApp(fetch);
    const token = await createSessionToken(testEnv, { sub: "auth0|1", name: "Ada" });
    const signedIn = await app.request("/whoami", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }, testEnv);
    expect(await signedIn.json()).toEqual({ sub: "auth0|1", name: "Ada" });
    const anonymous = await app.request("/whoami", {}, testEnv);
    expect(await anonymous.json()).toBeNull();

    const redirect = await app.request("/private?x=1", {}, testEnv);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/auth/login?returnTo=%2Fprivate%3Fx%3D1");
  });
});

describe("safeReturnTo", () => {
  it("keeps paths of this site", () => {
    expect(safeReturnTo("/ada/1")).toBe("/ada/1");
    expect(safeReturnTo("/verify?a=b#c")).toBe("/verify?a=b#c");
  });

  it("refuses anything that could leave the site", () => {
    for (const bad of ["https://evil.test/", "//evil.test", "/\\evil.test", "evil", "", "/a\nb", "javascript:alert(1)", null, undefined]) {
      expect(safeReturnTo(bad)).toBe("/");
    }
  });
});

describe("login", () => {
  it("answers 503 and names the missing settings when Auth0 is not configured", async () => {
    const app = makeApp(fetch);
    const response = await app.request("/auth/login", {}, { ...testEnv, AUTH0_CLIENT_SECRET: undefined, SESSION_SECRET: undefined });
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain("AUTH0_CLIENT_SECRET");
    expect(html).toContain("SESSION_SECRET");
    expect(html).not.toContain("AUTH0_DOMAIN");
  });

  it("redirects to Auth0 with PKCE, state and nonce", async () => {
    const response = await makeApp(fetch).request("/auth/login?returnTo=/verify", {}, testEnv);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(`https://${DOMAIN}/authorize`);
    expect(location.searchParams.get("client_id")).toBe("client-1");
    expect(location.searchParams.get("redirect_uri")).toBe("https://xposts.test/auth/callback");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    const setCookie = response.headers.getSetCookie()[0]!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
  });

  it("does not set Secure on http://localhost", async () => {
    const response = await makeApp(fetch).request("/auth/login", {}, { ...testEnv, PUBLIC_URL: "http://localhost:8787" });
    const setCookie = response.headers.getSetCookie()[0]!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).not.toContain("Secure");
  });
});

describe("callback", () => {
  async function startLogin(app: Hono<AppEnv>, returnTo = "/verify") {
    const login = await app.request(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`, {}, testEnv);
    const location = new URL(login.headers.get("location")!);
    return {
      cookie: cookies(login),
      state: location.searchParams.get("state")!,
      nonce: location.searchParams.get("nonce")!,
      challenge: location.searchParams.get("code_challenge")!,
    };
  }

  function auth0(options: { token?: (nonce: string, body: URLSearchParams) => Promise<Response> }) {
    const calls: { url: string; body?: URLSearchParams }[] = [];
    let nonce = "";
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body instanceof URLSearchParams ? init.body : undefined;
      calls.push({ url, body });
      if (url === `https://${DOMAIN}/oauth/token`) return options.token!(nonce, body!);
      if (url === `https://${DOMAIN}/.well-known/jwks.json`) return Response.json(jwks);
      throw new Error(`unexpected request to ${url}`);
    }) as typeof fetch;
    return { fetchImpl, calls, setNonce: (value: string) => (nonce = value) };
  }

  it("exchanges the code, verifies the ID token and sets the session", async () => {
    const mock = auth0({
      token: async (nonce) => Response.json({ id_token: await idToken({ nonce }) }),
    });
    const app = makeApp(mock.fetchImpl);
    const login = await startLogin(app);
    mock.setNonce(login.nonce);

    const response = await app.request(
      `/auth/callback?code=the-code&state=${login.state}`,
      { headers: { cookie: login.cookie } },
      testEnv,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/verify");

    const token = mock.calls[0]!.body!;
    expect(token.get("code")).toBe("the-code");
    expect(token.get("client_secret")).toBe("client-secret");
    expect(token.get("redirect_uri")).toBe("https://xposts.test/auth/callback");
    // The verifier sent to Auth0 hashes to the challenge sent in the authorize request.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token.get("code_verifier")!));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(challenge).toBe(login.challenge);

    const setCookie = response.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`))!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
    const session = await readSessionToken(testEnv, setCookie.split(";")[0]!.split("=")[1]);
    expect(session).toEqual({ sub: "auth0|ada", name: "Ada Lovelace", picture: "https://img.test/ada.png" });
  });

  it("refuses a wrong state, a missing cookie and a wrong nonce", async () => {
    const mock = auth0({ token: async () => Response.json({ id_token: await idToken({ nonce: "not-the-nonce" }) }) });
    const app = makeApp(mock.fetchImpl);
    const login = await startLogin(app);

    const wrongState = await app.request("/auth/callback?code=c&state=other", { headers: { cookie: login.cookie } }, testEnv);
    expect(wrongState.status).toBe(400);
    const noCookie = await app.request(`/auth/callback?code=c&state=${login.state}`, {}, testEnv);
    expect(noCookie.status).toBe(400);
    const wrongNonce = await app.request(`/auth/callback?code=c&state=${login.state}`, { headers: { cookie: login.cookie } }, testEnv);
    expect(wrongNonce.status).toBe(400);
    expect(await wrongNonce.text()).toContain("nonce");
    expect(wrongNonce.headers.getSetCookie().some((line) => line.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
  });

  it("refuses an ID token for another audience or signed by another key", async () => {
    const other = await generateKeyPair("RS256");
    let mode: "audience" | "key" = "audience";
    const mock = auth0({
      token: async (nonce) => {
        const token =
          mode === "audience"
            ? await idToken({ nonce }, { audience: "someone-else" })
            : await new SignJWT({ nonce, name: "Mallory" })
                .setProtectedHeader({ alg: "RS256", kid: "k1" })
                .setSubject("auth0|mallory")
                .setIssuer(`https://${DOMAIN}/`)
                .setAudience("client-1")
                .setExpirationTime("5m")
                .sign(other.privateKey);
        return Response.json({ id_token: token });
      },
    });
    const app = makeApp(mock.fetchImpl);
    for (mode of ["audience", "key"] as const) {
      const login = await startLogin(app);
      mock.setNonce(login.nonce);
      const response = await app.request(`/auth/callback?code=c&state=${login.state}`, { headers: { cookie: login.cookie } }, testEnv);
      expect(response.status).toBe(400);
    }
  });

  it("reports a token endpoint failure as 502", async () => {
    const mock = auth0({ token: async () => new Response("no", { status: 403 }) });
    const app = makeApp(mock.fetchImpl);
    const login = await startLogin(app);
    const response = await app.request(`/auth/callback?code=c&state=${login.state}`, { headers: { cookie: login.cookie } }, testEnv);
    expect(response.status).toBe(502);
  });

  it("ignores an unsafe returnTo from the login state", async () => {
    const mock = auth0({ token: async (nonce) => Response.json({ id_token: await idToken({ nonce }) }) });
    const app = makeApp(mock.fetchImpl);
    const login = await startLogin(app, "//evil.test");
    mock.setNonce(login.nonce);
    const response = await app.request(`/auth/callback?code=c&state=${login.state}`, { headers: { cookie: login.cookie } }, testEnv);
    expect(response.headers.get("location")).toBe("/");
  });
});

describe("logout", () => {
  it("clears the session and goes through Auth0", async () => {
    const response = await makeApp(fetch).request("/auth/logout", {}, testEnv);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(`https://${DOMAIN}/v2/logout`);
    expect(location.searchParams.get("returnTo")).toBe("https://xposts.test");
    expect(response.headers.getSetCookie().join("\n")).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
  });
});
