import { config } from "../config";
import { fetchJson } from "../utils/http";

const CHAIN_ID = 1;

export interface EtherscanTx {
  hash: string;
  from: string;
  to: string;
  value: string; // wei
  input: string; // hex calldata
  blockNumber: string;
  timeStamp: string;
  isError: string;
}

export interface EtherscanInternalTx {
  hash: string;
  from: string;
  to: string;
  value: string; // wei
}

export interface EtherscanTokenTx {
  hash: string;
  from: string;
  to: string;
  value: string; // token base units
  contractAddress: string;
  tokenDecimal: string;
  blockNumber: string;
  timeStamp: string;
}

interface EtherscanListResponse<T> {
  status: string;
  message: string;
  result: T[] | string;
}

// Etherscan free tier is roughly 5 req/sec; stay comfortably under it.
let lastCallAt = 0;
async function throttle(minGapMs = 220) {
  const wait = lastCallAt + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function call<T>(params: Record<string, string>): Promise<T[]> {
  await throttle();
  const qs = new URLSearchParams({
    chainid: String(CHAIN_ID),
    apikey: config.etherscan.apiKey,
    ...params,
  });
  const data = await fetchJson<EtherscanListResponse<T>>(`${config.etherscan.baseUrl}?${qs}`);
  if (typeof data.result === "string") {
    // Etherscan returns a string message (e.g. "No transactions found") on empty results.
    return [];
  }
  return data.result;
}

/** Plain ETH transfer history for a wallet (used to estimate ETH spent/received around trades). */
export async function getNormalTransactions(
  address: string,
  opts: { startBlock?: number; endBlock?: number } = {}
): Promise<EtherscanTx[]> {
  return call<EtherscanTx>({
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
): Promise<EtherscanTokenTx[]> {
  return call<EtherscanTokenTx>({
    module: "account",
    action: "tokentx",
    address,
    ...(contractAddress ? { contractaddress: contractAddress } : {}),
    sort: "asc",
  });
}

/** Internal (contract-to-EOA) ETH transfers for one transaction -- used to find ETH proceeds of a sell swap. */
export async function getInternalTransactionsByHash(txHash: string): Promise<EtherscanInternalTx[]> {
  return call<EtherscanInternalTx>({
    module: "account",
    action: "txlistinternal",
    txhash: txHash,
  });
}

/** Earliest ERC20 transfers *out of* a token contract -- i.e. its first buyers/recipients. */
export async function getEarliestTokenRecipients(
  tokenAddress: string,
  limit = 200
): Promise<EtherscanTokenTx[]> {
  const txs = await call<EtherscanTokenTx>({
    module: "account",
    action: "tokentx",
    contractaddress: tokenAddress,
    sort: "asc",
    page: "1",
    offset: String(limit),
  });
  return txs;
}
