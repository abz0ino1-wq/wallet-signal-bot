import { config } from "../config";
import { fetchJson } from "../utils/http";

export interface BlockscoutTx {
  hash: string;
  from: string;
  to: string;
  value: string; // wei
  input: string; // hex calldata
  blockNumber: string;
  timeStamp: string;
  isError: string;
}

export interface BlockscoutInternalTx {
  hash: string;
  from: string;
  to: string;
  value: string; // wei
}

export interface BlockscoutTokenTx {
  hash: string;
  from: string;
  to: string;
  value: string; // token base units
  contractAddress: string;
  tokenDecimal: string;
  blockNumber: string;
  timeStamp: string;
}

interface BlockscoutListResponse<T> {
  status: string;
  message: string;
  result: T[] | string;
}

// Conservative default throttle for the free, keyless Blockscout API tier.
let lastCallAt = 0;
async function throttle(minGapMs = 250) {
  const wait = lastCallAt + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function call<T>(params: Record<string, string>): Promise<T[]> {
  await throttle();
  const qs = new URLSearchParams(params);
  const data = await fetchJson<BlockscoutListResponse<T>>(`${config.blockscout.baseUrl}?${qs}`);
  if (typeof data.result === "string") {
    // Etherscan-compatible APIs return a string message (e.g. "No transactions found") on empty results.
    return [];
  }
  return data.result;
}

/** Plain native-ETH transfer history for a wallet (used to estimate ETH spent/received around trades). */
export async function getNormalTransactions(
  address: string,
  opts: { startBlock?: number; endBlock?: number } = {}
): Promise<BlockscoutTx[]> {
  return call<BlockscoutTx>({
    module: "account",
    action: "txlist",
    address,
    startblock: String(opts.startBlock ?? 0),
    endblock: String(opts.endBlock ?? 99_999_999),
    sort: "asc",
  });
}

/** ERC20 transfer history for a wallet, optionally filtered to one token contract. */
export async function getTokenTransactions(
  address: string,
  contractAddress?: string
): Promise<BlockscoutTokenTx[]> {
  return call<BlockscoutTokenTx>({
    module: "account",
    action: "tokentx",
    address,
    ...(contractAddress ? { contractaddress: contractAddress } : {}),
    sort: "asc",
  });
}

/** Internal (contract-to-EOA) ETH transfers for one transaction -- used to find ETH proceeds of a sell swap. */
export async function getInternalTransactionsByHash(txHash: string): Promise<BlockscoutInternalTx[]> {
  return call<BlockscoutInternalTx>({
    module: "account",
    action: "txlistinternal",
    txhash: txHash,
  });
}

/** Earliest ERC20 transfers *out of* a token contract -- i.e. its first buyers/recipients. */
export async function getEarliestTokenRecipients(
  tokenAddress: string,
  limit = 200
): Promise<BlockscoutTokenTx[]> {
  return call<BlockscoutTokenTx>({
    module: "account",
    action: "tokentx",
    contractaddress: tokenAddress,
    sort: "asc",
    page: "1",
    offset: String(limit),
  });
}
