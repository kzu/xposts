// The archive's Algorand account: mnemonic to key, address, Ed25519 signing.

import { sha512_256 } from "./sha512";
import { WORDS } from "./wordlist";

export interface Account {
  address: string;
  publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding, as Algorand writes addresses and transaction ids. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}

/** The address of a public key: base32 of the key and the last 4 bytes of its SHA-512/256. */
export function encodeAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new RangeError(`An Algorand public key has 32 bytes, not ${publicKey.length}.`);
  const withChecksum = new Uint8Array(36);
  withChecksum.set(publicKey);
  withChecksum.set(sha512_256(publicKey).slice(28), 32);
  return base32(withChecksum);
}

// A mnemonic is the 32-byte seed in 11-bit little-endian groups (24 words) and
// a checksum word: the first 11 bits of the seed's SHA-512/256.
function checksumWord(seed: Uint8Array): string {
  const hash = sha512_256(seed);
  return WORDS[hash[0]! | ((hash[1]! & 0x07) << 8)]!;
}

/** The 32-byte Ed25519 seed of a 25-word Algorand mnemonic. Errors never quote the words: they are the secret. */
export function seedFromMnemonic(mnemonic: string): Uint8Array {
  const words = mnemonic.trim().toLowerCase().split(/\s+/);
  if (words.length !== 25) throw new Error(`An Algorand mnemonic has 25 words, not ${words.length}.`);
  const seed = new Uint8Array(33);
  let acc = 0;
  let bits = 0;
  let length = 0;
  for (const [i, word] of words.slice(0, 24).entries()) {
    const index = WORDS.indexOf(word);
    if (index < 0) throw new Error(`Word ${i + 1} of the Algorand mnemonic is not in the BIP-39 English word list.`);
    acc |= index << bits;
    bits += 11;
    while (bits >= 8) {
      seed[length++] = acc & 0xff;
      acc >>>= 8;
      bits -= 8;
    }
  }
  // 24 × 11 = 264 bits: the last byte is padding and must be zero.
  if (bits !== 0 || length !== 33 || seed[32] !== 0) throw new Error("The Algorand mnemonic does not decode to a 32-byte key.");
  const key = seed.slice(0, 32);
  if (checksumWord(key) !== words[24]) throw new Error("The checksum word of the Algorand mnemonic does not match.");
  return key;
}

/** The 25-word mnemonic of a seed: the inverse of seedFromMnemonic. */
export function mnemonicFromSeed(seed: Uint8Array): string {
  if (seed.length !== 32) throw new RangeError(`An Ed25519 seed has 32 bytes, not ${seed.length}.`);
  const words: string[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of seed) {
    acc |= byte << bits;
    bits += 8;
    if (bits >= 11) {
      words.push(WORDS[acc & 0x7ff]!);
      acc >>>= 11;
      bits -= 11;
    }
  }
  words.push(WORDS[acc]!);
  words.push(checksumWord(seed));
  return words.join(" ");
}

// PKCS#8 wrapping of a raw Ed25519 seed (RFC 8410): Web Crypto imports private keys only in this form.
const PKCS8_ED25519_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

export async function accountFromSeed(seed: Uint8Array): Promise<Account> {
  if (seed.length !== 32) throw new RangeError(`An Ed25519 seed has 32 bytes, not ${seed.length}.`);
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_ED25519_PREFIX);
  pkcs8.set(seed, 16);
  // Extractable only to read the public key from its JWK.
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  if (!jwk.x) throw new Error("Web Crypto did not return the Ed25519 public key.");
  const publicKey = fromBase64(jwk.x);
  return {
    address: encodeAddress(publicKey),
    publicKey,
    sign: async (message) => new Uint8Array(await crypto.subtle.sign("Ed25519", key, message)),
  };
}

export async function accountFromMnemonic(mnemonic: string): Promise<Account> {
  return accountFromSeed(seedFromMnemonic(mnemonic));
}

/** Decodes base64 or base64url. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
