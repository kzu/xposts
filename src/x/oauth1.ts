// OAuth 1.0a request signing (RFC 5849, HMAC-SHA1), as X requires for
// requests made on behalf of the bot account.

import type { Env } from "../types.js";

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

export interface OAuth1Request {
  method: string;
  /** The full URL; its query parameters are part of the signature. */
  url: string;
  /** Parameters of an application/x-www-form-urlencoded body, which are signed too. JSON and multipart bodies are not. */
  form?: Record<string, string>;
}

/** The bot account's credentials. Throws naming the secrets that are missing. */
export function botCredentials(env: Env): OAuth1Credentials {
  const missing = (["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"] as const).filter((k) => !env[k]);
  if (missing.length) throw new Error(`OAuth 1.0a credentials are not configured: ${missing.join(", ")} missing`);
  return {
    consumerKey: env.X_API_KEY!,
    consumerSecret: env.X_API_SECRET!,
    token: env.X_ACCESS_TOKEN!,
    tokenSecret: env.X_ACCESS_SECRET!,
  };
}

/** RFC 3986 percent-encoding, which OAuth requires: encodeURIComponent leaves !'()* alone. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The signature base string of RFC 5849 section 3.4.1. */
export function signatureBase(request: OAuth1Request, oauthParams: Record<string, string>): string {
  const url = new URL(request.url);
  // URL already lower-cases the scheme and host and drops default ports.
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const pairs: [string, string][] = [
    ...url.searchParams.entries(),
    ...Object.entries(request.form ?? {}),
    ...Object.entries(oauthParams),
  ].map(([k, v]) => [percentEncode(k), percentEncode(v)]);
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const params = pairs.map(([k, v]) => `${k}=${v}`).join("&");
  return [request.method.toUpperCase(), percentEncode(baseUrl), percentEncode(params)].join("&");
}

/**
 * The Authorization header value for a request. `nonce` and `timestamp`
 * (seconds) are generated when not given; tests pin them.
 */
export async function oauth1Header(
  credentials: OAuth1Credentials,
  request: OAuth1Request,
  options: { nonce?: string; timestamp?: number } = {},
): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: options.nonce ?? randomNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(options.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: credentials.token,
    oauth_version: "1.0",
  };
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.tokenSecret)}`),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signatureBase(request, oauthParams)));
  const header = { ...oauthParams, oauth_signature: base64(signature) };
  return (
    "OAuth " +
    Object.keys(header)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(header[k as keyof typeof header])}"`)
      .join(", ")
  );
}
