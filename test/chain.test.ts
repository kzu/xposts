import algosdk from "algosdk";
import { describe, expect, it } from "vitest";

import { decodeNote, encodeNote, MAX_NOTE_BYTES } from "../src/chain";
import { accountFromMnemonic, encodeAddress, mnemonicFromSeed, seedFromMnemonic } from "../src/chain/account";
import { sha512_256 } from "../src/chain/sha512";
import { encodePayment, signPayment, transactionId, type PaymentFields } from "../src/chain/transaction";
import type { AnchorRecord } from "../src/types";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const text = (s: string) => new TextEncoder().encode(s);

const record: AnchorRecord = {
  postId: "2122184794209714368",
  ts: "20261116042737",
  png: "a".repeat(64),
  manifest: "0123456789abcdef".repeat(4),
  url: "https://xposts.example/p/2122184794209714368/20261116042737",
};

describe("notes", () => {
  it("round-trips a record in the documented format", () => {
    const note = encodeNote(record);
    expect(new TextDecoder().decode(note)).toBe(
      `xposts/v1:j{"p":"${record.postId}","t":"${record.ts}","i":"${record.png}","m":"${record.manifest}","u":"${record.url}"}`,
    );
    expect(decodeNote(note)).toEqual(record);
  });

  it("refuses to encode invalid records", () => {
    expect(() => encodeNote({ ...record, png: "A".repeat(64) })).toThrow(/png/);
    expect(() => encodeNote({ ...record, manifest: "ab" })).toThrow(/manifest/);
    expect(() => encodeNote({ ...record, ts: "2026" })).toThrow(/ts/);
    expect(() => encodeNote({ ...record, postId: "x" })).toThrow(/postId/);
    expect(() => encodeNote({ ...record, url: "javascript:alert(1)" })).toThrow(/url/);
  });

  it("throws past 1024 bytes", () => {
    const base = encodeNote({ ...record, url: "https://a.b/" }).length;
    const fits = { ...record, url: "https://a.b/" + "x".repeat(MAX_NOTE_BYTES - base) };
    expect(encodeNote(fits).length).toBe(MAX_NOTE_BYTES);
    expect(() => encodeNote({ ...fits, url: fits.url + "x" })).toThrow(/1025 bytes.*1024/);
  });

  it("decodes only well-formed xposts/v1 notes", () => {
    const json = (o: unknown) => text(`xposts/v1:j${JSON.stringify(o)}`);
    const fields = { p: record.postId, t: record.ts, i: record.png, m: record.manifest, u: record.url };
    expect(decodeNote(json(fields))).toEqual(record);
    expect(decodeNote(text("hello"))).toBeNull();
    expect(decodeNote(text(`xposts/v2:j${JSON.stringify(fields)}`))).toBeNull();
    expect(decodeNote(text("xposts/v1:j{not json"))).toBeNull();
    expect(decodeNote(text("xposts/v1:j[1]"))).toBeNull();
    expect(decodeNote(json({ ...fields, i: fields.i.toUpperCase() }))).toBeNull();
    expect(decodeNote(json({ ...fields, m: fields.m.slice(1) }))).toBeNull();
    expect(decodeNote(json({ ...fields, p: 20 }))).toBeNull();
    expect(decodeNote(json({ ...fields, extra: 1 }))).toBeNull();
    const { u: _, ...noUrl } = fields;
    expect(decodeNote(json(noUrl))).toBeNull();
    expect(decodeNote(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });
});

describe("sha512_256", () => {
  it("matches the FIPS 180-4 values across block boundaries", () => {
    expect(hex(sha512_256(text("")))).toBe("c672b8d1ef56ed28ab87c3622c5114069bdd3ad7b8f9737498d0c01ecef0967a");
    expect(hex(sha512_256(text("abc")))).toBe("53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23");
    expect(hex(sha512_256(text("a".repeat(111))))).toBe("0239e429f98d0ed61ee8e2a7c30afe98c1c3a80ce5dff62a107e9c538f7632ce");
    expect(hex(sha512_256(text("a".repeat(112))))).toBe("9216b5303edb66504570bee90e48ea5beaa5e9fe9f760bbd3e0460559fc005f6");
    expect(hex(sha512_256(text("a".repeat(1000))))).toBe("40eb4a70d4d69815407a9e272f0101cd67e3d11262a4a0bfc087712749c7fb53");
  });
});

describe("account", () => {
  it("reads mnemonics and derives addresses as algosdk does", async () => {
    for (let i = 0; i < 5; i++) {
      const generated = algosdk.generateAccount();
      const mnemonic = algosdk.secretKeyToMnemonic(generated.sk);
      expect(seedFromMnemonic(mnemonic)).toEqual(generated.sk.slice(0, 32));
      expect(mnemonicFromSeed(generated.sk.slice(0, 32))).toBe(mnemonic);
      const account = await accountFromMnemonic(`  ${mnemonic.toUpperCase().replace(/ /g, "\n ")} `);
      expect(account.address).toBe(generated.addr.toString());
      expect(encodeAddress(account.publicKey)).toBe(generated.addr.toString());
    }
  });

  it("rejects bad mnemonics without quoting them", () => {
    const words = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk).split(" ");
    expect(() => seedFromMnemonic(words.slice(1).join(" "))).toThrow(/25 words, not 24/);
    const misspelled = [...words.slice(0, 3), "zzzzz", ...words.slice(4)].join(" ");
    expect(() => seedFromMnemonic(misspelled)).toThrow(/Word 4 .* not in the BIP-39/);
    const wrongChecksum = [...words.slice(0, 24), words[24] === "abandon" ? "ability" : "abandon"].join(" ");
    expect(() => seedFromMnemonic(wrongChecksum)).toThrow(/checksum/);
    try {
      seedFromMnemonic(misspelled);
    } catch (error) {
      for (const word of words) expect((error as Error).message).not.toContain(` ${word} `);
    }
  });
});

describe("payment transactions", () => {
  it("encode and sign byte for byte as algosdk does, and the signature verifies", async () => {
    const generated = algosdk.generateAccount();
    const account = await accountFromMnemonic(algosdk.secretKeyToMnemonic(generated.sk));
    const genesisHash = algosdk.base64ToBytes("SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=");

    // Small and large values exercise every integer and length form of the encoding.
    for (const [round, fee, note] of [
      [5, 1000, encodeNote(record)],
      [69312740, 252, new Uint8Array(300).fill(7)],
      [2 ** 33, 70000, new Uint8Array(0)],
    ] as const) {
      const fields: PaymentFields = {
        sender: account.publicKey,
        receiver: account.publicKey,
        amount: 0,
        fee,
        firstValid: round,
        lastValid: round + 1000,
        genesisId: "testnet-v1.0",
        genesisHash,
        note,
      };
      const reference = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: generated.addr,
        receiver: generated.addr,
        amount: 0,
        note,
        suggestedParams: {
          flatFee: true,
          fee: BigInt(fee),
          minFee: 1000n,
          firstValid: round,
          lastValid: round + 1000,
          genesisID: "testnet-v1.0",
          genesisHash,
        },
      });

      expect(hex(encodePayment(fields))).toBe(hex(algosdk.encodeUnsignedTransaction(reference)));
      expect(transactionId(encodePayment(fields))).toBe(reference.txID());

      const signed = await signPayment(account, fields);
      expect(signed.txId).toBe(reference.txID());
      expect(hex(signed.bytes)).toBe(hex(reference.signTxn(generated.sk)));

      const decoded = algosdk.decodeSignedTransaction(signed.bytes);
      expect(decoded.txn.type).toBe("pay");
      expect(decoded.txn.sender.toString()).toBe(account.address);
      expect(decoded.txn.payment?.receiver.toString()).toBe(account.address);
      expect(decoded.txn.payment?.amount).toBe(0n);
      expect(decoded.txn.note).toEqual(note);
      const key = await crypto.subtle.importKey("raw", account.publicKey, { name: "Ed25519" }, false, ["verify"]);
      const message = decoded.txn.bytesToSign();
      expect(await crypto.subtle.verify("Ed25519", key, decoded.sig!, message)).toBe(true);
    }
  });

  it("refuses to sign for another sender", async () => {
    const account = await accountFromMnemonic(algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk));
    const other = algosdk.generateAccount().addr.publicKey;
    const fields: PaymentFields = {
      sender: other,
      receiver: other,
      amount: 0,
      fee: 1000,
      firstValid: 1,
      lastValid: 2,
      genesisId: "testnet-v1.0",
      genesisHash: new Uint8Array(32),
      note: new Uint8Array(0),
    };
    await expect(signPayment(account, fields)).rejects.toThrow(/not the signing account/);
  });
});
