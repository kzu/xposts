import type { AlgorandNetwork } from "../types";

/** Where anyone can look at a transaction without trusting this archive. */
export function explorerUrl(network: AlgorandNetwork, txId: string): string {
  const host = network === "mainnet" ? "allo.info" : "testnet.explorer.perawallet.app";
  return `https://${host}/tx/${txId}`;
}
