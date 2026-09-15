import { httpClient } from "./viemClient";
import { UNISWAP_V4_POOL_MANAGER, poolTokensAbi, uniswapV4InitializeEventAbi } from "../decode/uniswapAbi";
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

  // V4 pools are keyed by a bytes32 poolId, not a deployed contract address
  // -- there's no token0()/token1() to call (that's V2/V3-specific). But
  // currency0/currency1 for a given poolId only ever appear on-chain in
  // that pool's original Initialize event (id is an indexed topic), so a
  // V4 pool the bot didn't personally see get created is still resolvable
  // via a historical log lookup rather than being permanently invisible.
  if (key.length !== 42) {
    const promise = (async (): Promise<PoolTokens | null> => {
      try {
        const logs = await httpClient.getLogs({
          address: UNISWAP_V4_POOL_MANAGER as `0x${string}`,
          event: uniswapV4InitializeEventAbi[0],
          args: { id: key as `0x${string}` },
          strict: true,
          fromBlock: 0n,
          toBlock: "latest",
        });
        const log = logs[0];
        if (!log) return null;
        const tokens: PoolTokens = {
          token0: log.args.currency0.toLowerCase(),
          token1: log.args.currency1.toLowerCase(),
        };
        cache.set(key, tokens);
        return tokens;
      } catch (err) {
        logger.warn(`poolRegistry: failed to resolve V4 pool ${poolAddress} via historical Initialize log: ${(err as Error).message}`);
        return null;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, promise);
    return promise;
  }

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
