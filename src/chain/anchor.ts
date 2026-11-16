// Writing capture hashes to Algorand and reading them back.
//
// An anchor is a zero-amount payment from the archive's account to itself
// whose note is the capture's record (see note.ts). Anyone can then check, on
// any Algorand node or explorer, that those hashes existed at that round.

import type { Anchor, AnchorRecord, AlgorandNetwork, Env } from "../types";
import { accountFromMnemonic, fromBase64 } from "./account";
import { decodeNote, encodeNote } from "./note";
import { signedSize, signPayment, type PaymentFields } from "./transaction";

type Fetch = typeof fetch;
type ChainEnv = Pick<Env, "ALGORAND_NETWORK" | "ALGORAND_MNEMONIC" | "ALGOD_URL" | "INDEXER_URL">;

/** Public endpoints of Nodely's free tier, which need no token. */
const PUBLIC_ALGOD: Record<AlgorandNetwork, string> = {
  mainnet: "https://mainnet-api.4160.nodely.dev",
  testnet: "https://testnet-api.4160.nodely.dev",
};
const PUBLIC_INDEXER: Record<AlgorandNetwork, string> = {
  mainnet: "https://mainnet-idx.4160.nodely.dev",
  testnet: "https://testnet-idx.4160.nodely.dev",
};
const GENESIS_ID: Record<AlgorandNetwork, string> = {
  mainnet: "mainnet-v1.0",
  testnet: "testnet-v1.0",
};

/** How long a transaction stays valid for submission (the protocol's maximum). */
const VALIDITY_ROUNDS = 1000;
/** How many rounds (about 3 s each) to wait for confirmation before giving up. */
const CONFIRMATION_ROUNDS = 10;

export function isAnchorConfigured(env: ChainEnv): boolean {
  return Boolean(env.ALGORAND_MNEMONIC?.trim());
}

/**
 * The archive's account, whose transactions are all the anchors; null without
 * a mnemonic. Async because Web Crypto derives the public key.
 */
export async function anchorAddress(env: ChainEnv): Promise<string | null> {
  if (!isAnchorConfigured(env)) return null;
  return (await accountFromMnemonic(env.ALGORAND_MNEMONIC!)).address;
}

function networkOf(env: ChainEnv): AlgorandNetwork {
  const value = env.ALGORAND_NETWORK;
  if (value !== "mainnet" && value !== "testnet") {
    throw new Error(`ALGORAND_NETWORK must be "mainnet" or "testnet", not "${value}".`);
  }
  return value;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

async function failure(service: string, method: string, url: string, response: Response): Promise<Error> {
  const body = await response.text();
  let message = body.slice(0, 300);
  try {
    message = (JSON.parse(body) as { message?: string }).message ?? message;
  } catch {
    // Not JSON: keep the text.
  }
  return new Error(`${service} ${method} ${new URL(url).pathname} failed with ${response.status}: ${message}`);
}

async function request<T>(fetchImpl: Fetch, service: string, url: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw await failure(service, init?.method ?? "GET", url, response);
  return (await response.json()) as T;
}

interface TransactionParams {
  fee: number;
  "min-fee": number;
  "genesis-hash": string;
  "genesis-id": string;
  "last-round": number;
}

interface PendingTransaction {
  "confirmed-round"?: number;
  "pool-error"?: string;
}

export async function anchor(env: ChainEnv, record: AnchorRecord, fetchImpl: Fetch = fetch): Promise<Anchor> {
  if (!isAnchorConfigured(env)) throw new Error("ALGORAND_MNEMONIC is not set: captures cannot be anchored.");
  const network = networkOf(env);
  const algod = trimSlash(env.ALGOD_URL || PUBLIC_ALGOD[network]);
  const note = encodeNote(record);
  const account = await accountFromMnemonic(env.ALGORAND_MNEMONIC!);

  const params = await request<TransactionParams>(fetchImpl, "algod", `${algod}/v2/transactions/params`);
  if (params["genesis-id"] !== GENESIS_ID[network]) {
    throw new Error(`algod at ${algod} serves ${params["genesis-id"]}, but ALGORAND_NETWORK is ${network}.`);
  }
  const fields: PaymentFields = {
    sender: account.publicKey,
    receiver: account.publicKey,
    amount: 0,
    fee: params["min-fee"],
    firstValid: params["last-round"],
    lastValid: params["last-round"] + VALIDITY_ROUNDS,
    genesisId: params["genesis-id"],
    genesisHash: fromBase64(params["genesis-hash"]),
    note,
  };
  // The fee is per byte of the signed transaction with a minimum; the per-byte
  // rate is 0 unless the network is congested. The fee's own encoding counts
  // in the size, so settle on a fee that covers the size it produces.
  for (let fee = 0; fee !== fields.fee; ) {
    fee = fields.fee;
    fields.fee = Math.max(params["min-fee"], params.fee * signedSize(fields));
  }
  const signed = await signPayment(account, fields);

  const submitted = await request<{ txId: string }>(fetchImpl, "algod", `${algod}/v2/transactions`, {
    method: "POST",
    headers: { "content-type": "application/x-binary" },
    body: signed.bytes,
  });
  if (submitted.txId !== signed.txId) {
    throw new Error(`algod accepted transaction ${submitted.txId}, but the signed transaction is ${signed.txId}.`);
  }

  const round = await waitForConfirmation(fetchImpl, algod, signed.txId, params["last-round"]);
  return { network, txId: signed.txId, round };
}

async function waitForConfirmation(fetchImpl: Fetch, algod: string, txId: string, startRound: number): Promise<number> {
  for (let round = startRound; round < startRound + CONFIRMATION_ROUNDS; round++) {
    const url = `${algod}/v2/transactions/pending/${txId}?format=json`;
    const response = await fetchImpl(url);
    // A load-balanced endpoint may answer from a node that has not seen the transaction yet.
    if (response.status !== 404) {
      if (!response.ok) throw await failure("algod", "GET", url, response);
      const pending = (await response.json()) as PendingTransaction;
      if (pending["confirmed-round"]) return pending["confirmed-round"];
      if (pending["pool-error"]) throw new Error(`Algorand rejected transaction ${txId}: ${pending["pool-error"]}`);
    } else {
      await response.body?.cancel();
    }
    // Returns once the network has moved past this round.
    await request(fetchImpl, "algod", `${algod}/v2/status/wait-for-block-after/${round}`);
  }
  throw new Error(
    `Transaction ${txId} was not confirmed within ${CONFIRMATION_ROUNDS} rounds; it stays valid until round ${startRound + VALIDITY_ROUNDS}.`,
  );
}

export interface ReadAnchor {
  record: AnchorRecord;
  round: number;
  /** Time of the block, ISO 8601. */
  time: string;
  /** The account that wrote it: compare with anchorAddress() to know it came from this archive. */
  sender: string;
}

interface IndexerTransaction {
  note?: string;
  sender: string;
  "confirmed-round": number;
  "round-time": number;
}

/**
 * Reads an anchor back from the indexer. Null when there is no such
 * transaction (including ids that are not transaction ids) or its note is not
 * an xposts note.
 */
export async function readAnchor(
  env: ChainEnv,
  network: AlgorandNetwork,
  txId: string,
  fetchImpl: Fetch = fetch,
): Promise<ReadAnchor | null> {
  if (!/^[A-Z2-7]{52}$/.test(txId)) return null;
  // INDEXER_URL serves the archive's own network; other networks use the public indexer.
  const indexer = trimSlash(network === env.ALGORAND_NETWORK && env.INDEXER_URL ? env.INDEXER_URL : PUBLIC_INDEXER[network]);
  const url = `${indexer}/v2/transactions/${txId}`;
  const response = await fetchImpl(url);
  if (response.status === 404) return null;
  if (!response.ok) throw await failure("indexer", "GET", url, response);
  const { transaction } = (await response.json()) as { transaction?: IndexerTransaction };
  if (!transaction) throw new Error(`indexer returned no transaction for ${txId}.`);
  if (!transaction.note) return null;
  const record = decodeNote(fromBase64(transaction.note));
  if (!record) return null;
  return {
    record,
    round: transaction["confirmed-round"],
    time: new Date(transaction["round-time"] * 1000).toISOString(),
    sender: transaction.sender,
  };
}
