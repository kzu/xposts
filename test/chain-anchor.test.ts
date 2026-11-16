import algosdk from "algosdk";
import { describe, expect, it } from "vitest";

import { anchor, anchorAddress, encodeNote, isAnchorConfigured, readAnchor } from "../src/chain";
import type { AnchorRecord, Env } from "../src/types";

type ChainEnv = Pick<Env, "ALGORAND_NETWORK" | "ALGORAND_MNEMONIC" | "ALGOD_URL" | "INDEXER_URL">;

const record: AnchorRecord = {
  postId: "20",
  ts: "20261116042737",
  png: "a".repeat(64),
  manifest: "b".repeat(64),
  url: "https://xposts.example/p/20/20261116042737",
};

// A throwaway account, never funded.
const generated = algosdk.generateAccount();
const env: ChainEnv = { ALGORAND_NETWORK: "testnet", ALGORAND_MNEMONIC: algosdk.secretKeyToMnemonic(generated.sk) };

const PARAMS = {
  "consensus-version": "v1",
  fee: 0,
  "genesis-hash": "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
  "genesis-id": "testnet-v1.0",
  "last-round": 69312740,
  "min-fee": 1000,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A mocked algod: `pending` answers each poll of the pending transaction, in order. */
function mockAlgod(pending: (txId: string, poll: number) => Response, params = PARAMS) {
  const calls: string[] = [];
  let submitted: algosdk.SignedTransaction | undefined;
  let polls = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.pathname === "/v2/transactions/params") return json(params);
    if (url.pathname === "/v2/transactions" && init?.method === "POST") {
      expect(new Headers(init.headers).get("content-type")).toBe("application/x-binary");
      submitted = algosdk.decodeSignedTransaction(init.body as Uint8Array);
      return json({ txId: submitted.txn.txID() });
    }
    const pendingMatch = /^\/v2\/transactions\/pending\/([A-Z2-7]{52})$/.exec(url.pathname);
    if (pendingMatch) return pending(pendingMatch[1]!, polls++);
    if (url.pathname.startsWith("/v2/status/wait-for-block-after/")) return json({ "last-round": 1 });
    return json({ message: "not mocked" }, 500);
  }) as typeof fetch;
  return { fetchImpl, calls, submitted: () => submitted };
}

describe("anchor", () => {
  it("submits a signed zero payment to itself and waits for confirmation", async () => {
    const algod = mockAlgod((_, poll) =>
      poll === 0 ? new Response("{}", { status: 404 }) : poll === 1 ? json({ "pool-error": "" }) : json({ "confirmed-round": 69312743 }),
    );
    const result = await anchor(env, record, algod.fetchImpl);

    const signed = algod.submitted()!;
    expect(result).toEqual({ network: "testnet", txId: signed.txn.txID(), round: 69312743 });
    expect(signed.txn.sender.toString()).toBe(generated.addr.toString());
    expect(signed.txn.payment?.receiver.toString()).toBe(generated.addr.toString());
    expect(signed.txn.payment?.amount).toBe(0n);
    expect(signed.txn.fee).toBe(1000n);
    expect(signed.txn.firstValid).toBe(69312740n);
    expect(signed.txn.lastValid).toBe(69313740n);
    expect(signed.txn.note).toEqual(encodeNote(record));
    const key = await crypto.subtle.importKey("raw", generated.addr.publicKey, { name: "Ed25519" }, false, ["verify"]);
    expect(await crypto.subtle.verify("Ed25519", key, signed.sig!, signed.txn.bytesToSign())).toBe(true);

    expect(algod.calls).toEqual([
      "GET https://testnet-api.4160.nodely.dev/v2/transactions/params",
      "POST https://testnet-api.4160.nodely.dev/v2/transactions",
      `GET https://testnet-api.4160.nodely.dev/v2/transactions/pending/${result.txId}`,
      "GET https://testnet-api.4160.nodely.dev/v2/status/wait-for-block-after/69312740",
      `GET https://testnet-api.4160.nodely.dev/v2/transactions/pending/${result.txId}`,
      "GET https://testnet-api.4160.nodely.dev/v2/status/wait-for-block-after/69312741",
      `GET https://testnet-api.4160.nodely.dev/v2/transactions/pending/${result.txId}`,
    ]);
  });

  it("uses ALGOD_URL and pays the per-byte fee when the network asks for one", async () => {
    const algod = mockAlgod(() => json({ "confirmed-round": 5 }), { ...PARAMS, fee: 100 });
    await anchor({ ...env, ALGOD_URL: "https://algod.example/" }, record, algod.fetchImpl);
    expect(algod.calls[0]).toBe("GET https://algod.example/v2/transactions/params");
    const signed = algod.submitted()!;
    expect(signed.txn.fee).toBe(BigInt(100 * algosdk.encodeMsgpack(signed).length));
  });

  it("gives up after 10 rounds", async () => {
    const algod = mockAlgod(() => json({ "pool-error": "" }));
    await expect(anchor(env, record, algod.fetchImpl)).rejects.toThrow(/not confirmed within 10 rounds/);
    expect(algod.calls.filter((c) => c.includes("/pending/"))).toHaveLength(10);
  });

  it("fails on a pool error, a wrong network, or no mnemonic", async () => {
    await expect(anchor(env, record, mockAlgod(() => json({ "pool-error": "overspend" })).fetchImpl)).rejects.toThrow(
      /rejected transaction .*: overspend/,
    );
    const mainnet = mockAlgod(() => json({}), { ...PARAMS, "genesis-id": "mainnet-v1.0" });
    await expect(anchor(env, record, mainnet.fetchImpl)).rejects.toThrow(/serves mainnet-v1.0, but ALGORAND_NETWORK is testnet/);
    await expect(anchor({ ALGORAND_NETWORK: "testnet" }, record, mainnet.fetchImpl)).rejects.toThrow(/ALGORAND_MNEMONIC is not set/);
  });

  it("reports algod errors with their message", async () => {
    const failing = (async () => json({ message: "TransactionPool.Remember: below min fee" }, 400)) as typeof fetch;
    await expect(anchor(env, record, failing)).rejects.toThrow(/algod GET \/v2\/transactions\/params failed with 400: .*below min fee/);
  });
});

describe("anchorAddress", () => {
  it("is the mnemonic's address, or null without one", async () => {
    expect(await anchorAddress(env)).toBe(generated.addr.toString());
    expect(await anchorAddress({ ALGORAND_NETWORK: "testnet" })).toBeNull();
    expect(isAnchorConfigured(env)).toBe(true);
    expect(isAnchorConfigured({ ALGORAND_NETWORK: "testnet", ALGORAND_MNEMONIC: " " })).toBe(false);
  });
});

describe("readAnchor", () => {
  const txId = "QOOBRVQMX4HW5QZ2EGLQDQCQTKRF3UP3JKDGKYPCXMI6AVV35KQA";
  const indexerTx = (note?: Uint8Array) => ({
    "current-round": 69312742,
    transaction: {
      "confirmed-round": 69312743,
      id: txId,
      note: note && btoa(String.fromCharCode(...note)),
      "payment-transaction": { amount: 0, receiver: generated.addr.toString() },
      "round-time": 1763267257,
      sender: generated.addr.toString(),
      "tx-type": "pay",
    },
  });
  const mockIndexer = (response: () => Response) => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return response();
    }) as typeof fetch;
    return { fetchImpl, urls };
  };

  it("decodes the note of the transaction", async () => {
    const indexer = mockIndexer(() => json(indexerTx(encodeNote(record))));
    expect(await readAnchor(env, "testnet", txId, indexer.fetchImpl)).toEqual({
      record,
      round: 69312743,
      time: "2025-11-16T04:27:37.000Z",
      sender: generated.addr.toString(),
    });
    expect(indexer.urls).toEqual([`https://testnet-idx.4160.nodely.dev/v2/transactions/${txId}`]);
  });

  it("uses INDEXER_URL for the archive's network only", async () => {
    const indexer = mockIndexer(() => json(indexerTx(encodeNote(record))));
    const custom = { ...env, INDEXER_URL: "https://idx.example" };
    await readAnchor(custom, "testnet", txId, indexer.fetchImpl);
    await readAnchor(custom, "mainnet", txId, indexer.fetchImpl);
    expect(indexer.urls).toEqual([
      `https://idx.example/v2/transactions/${txId}`,
      `https://mainnet-idx.4160.nodely.dev/v2/transactions/${txId}`,
    ]);
  });

  it("is null when the transaction is missing or not an xposts anchor", async () => {
    const notFound = mockIndexer(() => json({ message: "no transaction found" }, 404));
    expect(await readAnchor(env, "testnet", txId, notFound.fetchImpl)).toBeNull();
    expect(await readAnchor(env, "testnet", txId, mockIndexer(() => json(indexerTx())).fetchImpl)).toBeNull();
    const other = mockIndexer(() => json(indexerTx(new TextEncoder().encode("hello"))));
    expect(await readAnchor(env, "testnet", txId, other.fetchImpl)).toBeNull();
    expect(await readAnchor(env, "testnet", "../../v2/accounts", notFound.fetchImpl)).toBeNull();
    expect(notFound.urls).toHaveLength(1);
  });

  it("fails loudly when the indexer fails", async () => {
    const down = mockIndexer(() => new Response("upstream timeout", { status: 503 }));
    await expect(readAnchor(env, "testnet", txId, down.fetchImpl)).rejects.toThrow(/indexer GET .* failed with 503: upstream timeout/);
  });
});
