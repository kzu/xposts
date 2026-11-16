import { describe, expect, it } from "vitest";

import { oauth1Header, percentEncode, signatureBase } from "../src/x/oauth1";

// The worked example of X's "Creating a signature" documentation
// (docs.x.com/resources/fundamentals/authentication/oauth-1-0a/creating-a-signature).
const credentials = {
  consumerKey: "xvz1evFS4wEEPTGEFPHBog",
  consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
  token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
  tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
};
const request = {
  method: "post",
  url: "https://api.x.com/1.1/statuses/update.json?include_entities=true",
  form: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
};
const pinned = { nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", timestamp: 1318622958 };

describe("oauth1Header", () => {
  it("builds the signature base string of the published example", () => {
    const base = signatureBase(request, {
      oauth_consumer_key: credentials.consumerKey,
      oauth_nonce: pinned.nonce,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: String(pinned.timestamp),
      oauth_token: credentials.token,
      oauth_version: "1.0",
    });
    expect(base).toBe(
      "POST&https%3A%2F%2Fapi.x.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
    );
  });

  it("signs the published example to its published signature", async () => {
    const header = await oauth1Header(credentials, request, pinned);
    expect(header).toBe(
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", oauth_signature="Ls93hJiZbQ3akF3HF3x1Bz8%2FzU4%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"',
    );
  });

  it("generates a fresh nonce and the current time when not pinned", async () => {
    const a = await oauth1Header(credentials, { method: "GET", url: "https://api.x.com/2/users/me" });
    const b = await oauth1Header(credentials, { method: "GET", url: "https://api.x.com/2/users/me" });
    expect(a).not.toBe(b);
    const ts = Number(/oauth_timestamp="(\d+)"/.exec(a)?.[1]);
    expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(60);
  });
});

describe("percentEncode", () => {
  it("encodes the characters encodeURIComponent leaves", () => {
    expect(percentEncode("a b!*'()~-._")).toBe("a%20b%21%2A%27%28%29~-._");
  });
});
