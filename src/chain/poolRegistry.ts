import { httpClient } from "./viemClient";
import { poolTokensAbi } from "../decode/uniswapAbi";
import { logger } from "../utils/logger";

interface PoolTokens {
  token0: string;
  token1: string;
}

const cache = new Map<string, PoolTokens>();
const inFlight = new Map<string, Promise<PoolTokens | null>>();

/** Populated directly from PairCreated/PoolCreated events -- no RPC call needed. */
export function registerPool(poolAddress: string, token0: string, token1: string) {
  cache.set(poolAddress.toLowerCase(), { token0: token0.toLowerCase(), token1: token1.toLowerCase() });
}

/** For pools created before this process started watching -- resolved on demand and cached. */
export async function getPoolTokens(poolAddress: string): Promise<PoolTokens | null> {
  const key = poolAddress.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<PoolTokens | null> => {
    try {
      const [token0, token1] = await Promise.all([
        httpClient.readContract({ address: key as `0x${string}`, abi: poolTokensAbi, functionName: "token0" }),
        httpClient.readContract({ address: key as `0x${string}`, abi: poolTokensAbi, functionName: "token1" }),
      ]);
      const tokens: PoolTokens = { token0: (token0 as string).toLowerCase(), token1: (token1 as string).toLowerCase() };
      cache.set(key, tokens);
      return tokens;
    } catch (err) {
      logger.warn(`poolRegistry: failed to resolve tokens for pool ${poolAddress}: ${(err as Error).message}`);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}
