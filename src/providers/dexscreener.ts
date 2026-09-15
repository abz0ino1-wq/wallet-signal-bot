import { fetchJson } from "../utils/http";
import type { DexscreenerPair } from "../types";

const BASE = "https://api.dexscreener.com";

interface TokenPairsResponse {
  pairs: DexscreenerPair[] | null;
}

interface LatestBoostedTokenProfile {
  chainId: string;
  tokenAddress: string;
  icon?: string;
  description?: string;
}

/**
 * Dexscreener's "token boosts" endpoint reflects tokens that paid for boosted
 * visibility -- the closest public proxy to the "dex paid" signal traders look
 * for on low-cap tokens. There is no official docs page guaranteeing shape
 * stability, so callers should treat fields defensively.
 */
export async function getLatestBoostedTokens(): Promise<LatestBoostedTokenProfile[]> {
  const data = await fetchJson<LatestBoostedTokenProfile[]>(
    `${BASE}/token-boosts/latest/v1`
  );
  return Array.isArray(data) ? data : [];
}

export async function getTopBoostedTokens(): Promise<LatestBoostedTokenProfile[]> {
  const data = await fetchJson<LatestBoostedTokenProfile[]>(`${BASE}/token-boosts/top/v1`);
  return Array.isArray(data) ? data : [];
}

export async function getPairsForToken(
  chainId: string,
  tokenAddress: string
): Promise<DexscreenerPair[]> {
  const data = await fetchJson<TokenPairsResponse | DexscreenerPair[]>(
    `${BASE}/token-pairs/v1/${chainId}/${tokenAddress}`
  );
  if (Array.isArray(data)) return data;
  return data.pairs ?? [];
}

export async function searchPairsByToken(query: string): Promise<DexscreenerPair[]> {
  const data = await fetchJson<TokenPairsResponse>(
    `${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`
  );
  return data.pairs ?? [];
}

/** Best (highest liquidity) pair for a token on a given chain, or null if none found. */
export async function getBestPair(
  chainId: string,
  tokenAddress: string
): Promise<DexscreenerPair | null> {
  const pairs = await getPairsForToken(chainId, tokenAddress);
  const onChain = pairs.filter((p) => p.chainId === chainId);
  if (onChain.length === 0) return null;
  onChain.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return onChain[0];
}
