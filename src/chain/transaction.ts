// Payment transactions in Algorand's canonical msgpack: map keys sorted,
// zero and empty values omitted, integers in their shortest form. The signed
// bytes are "TX" followed by that encoding; the id is its SHA-512/256 in base32.

import { base32, type Account } from "./account";
import { sha512_256 } from "./sha512";

export interface PaymentFields {
  sender: Uint8Array;
  receiver: Uint8Array;
  amount: number;
  fee: number;
  firstValid: number;
  lastValid: number;
  genesisId: string;
  genesisHash: Uint8Array;
  note: Uint8Array;
}

export interface SignedTransaction {
  txId: string;
  /** The msgpack of { sig, txn }, ready to submit to algod. */
  bytes: Uint8Array;
}

type Value = number | string | Uint8Array | { [key: string]: Value };

const encoder = new TextEncoder();

function isEmpty(value: Value): boolean {
  if (typeof value === "number") return value === 0;
  if (typeof value === "string" || value instanceof Uint8Array) return value.length === 0;
  return Object.keys(value).length === 0;
}

function lengthHeader(out: number[], length: number, fix: number | null, fixMax: number, codes: [number, number, number]): void {
  if (fix !== null && length <= fixMax) out.push(fix | length);
  else if (length <= 0xff && codes[0] !== 0) out.push(codes[0], length);
  else if (length <= 0xffff) out.push(codes[1], length >> 8, length & 0xff);
  else out.push(codes[2], (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff);
}

function encodeValue(out: number[], value: Value): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Cannot encode ${value}: only unsigned safe integers are supported.`);
    if (value < 0x80) out.push(value);
    else if (value <= 0xff) out.push(0xcc, value);
    else if (value <= 0xffff) out.push(0xcd, value >> 8, value & 0xff);
    else if (value <= 0xffffffff) out.push(0xce, (value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
    else {
      const big = BigInt(value);
      out.push(0xcf);
      for (let shift = 56n; shift >= 0n; shift -= 8n) out.push(Number((big >> shift) & 0xffn));
    }
  } else if (typeof value === "string") {
    const bytes = encoder.encode(value);
    lengthHeader(out, bytes.length, 0xa0, 31, [0xd9, 0xda, 0xdb]);
    out.push(...bytes);
  } else if (value instanceof Uint8Array) {
    lengthHeader(out, value.length, null, 0, [0xc4, 0xc5, 0xc6]);
    for (const byte of value) out.push(byte);
  } else {
    const keys = Object.keys(value)
      .filter((key) => !isEmpty(value[key]!))
      .sort();
    lengthHeader(out, keys.length, 0x80, 15, [0, 0xde, 0xdf]);
    for (const key of keys) {
      encodeValue(out, key);
      encodeValue(out, value[key]!);
    }
  }
}

function msgpack(value: Value): Uint8Array {
  const out: number[] = [];
  encodeValue(out, value);
  return Uint8Array.from(out);
}

function paymentMap(fields: PaymentFields): Value {
  for (const [name, key] of [["sender", fields.sender], ["receiver", fields.receiver]] as const) {
    if (key.length !== 32) throw new RangeError(`The ${name} must be a 32-byte public key.`);
  }
  if (fields.genesisHash.length !== 32) throw new RangeError("The genesis hash must have 32 bytes.");
  if (fields.lastValid < fields.firstValid) throw new RangeError("lastValid comes before firstValid.");
  return {
    amt: fields.amount,
    fee: fields.fee,
    fv: fields.firstValid,
    gen: fields.genesisId,
    gh: fields.genesisHash,
    lv: fields.lastValid,
    note: fields.note,
    rcv: fields.receiver,
    snd: fields.sender,
    type: "pay",
  };
}

/** The canonical msgpack of the unsigned transaction. */
export function encodePayment(fields: PaymentFields): Uint8Array {
  return msgpack(paymentMap(fields));
}

function bytesToSign(encodedTxn: Uint8Array): Uint8Array {
  const out = new Uint8Array(encodedTxn.length + 2);
  out.set(encoder.encode("TX"));
  out.set(encodedTxn, 2);
  return out;
}

export function transactionId(encodedTxn: Uint8Array): string {
  return base32(sha512_256(bytesToSign(encodedTxn)));
}

/** Size of the signed transaction, which algod's per-byte fee is charged on. */
export function signedSize(fields: PaymentFields): number {
  return msgpack({ sig: new Uint8Array(64).fill(1), txn: paymentMap(fields) }).length;
}

export async function signPayment(account: Account, fields: PaymentFields): Promise<SignedTransaction> {
  if (!equalBytes(account.publicKey, fields.sender)) throw new Error("The transaction's sender is not the signing account.");
  const txn = paymentMap(fields);
  const encoded = msgpack(txn);
  const sig = await account.sign(bytesToSign(encoded));
  return { txId: transactionId(encoded), bytes: msgpack({ sig, txn }) };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
