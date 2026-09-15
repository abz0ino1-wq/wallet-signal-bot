import { formatEther } from "viem";
import { wsClient } from "./viemClient";
import {
  UNISWAP_V4_POOL_MANAGER,
  uniswapV2SwapEventAbi,
  uniswapV3SwapEventAbi,
  uniswapV4SwapEventAbi,
} from "../decode/uniswapAbi";
import { getPoolTokens } from "./poolRegistry";
import { isWethOrNative } from "./weth";
import { logger } from "../utils/logger";
import type { DecodedSwap } from "../types";

/**
 * Watches confirmed Swap events chain-wide via topic-only WS subscriptions
 * (no per-pool address filter for V2/V3 -- the Swap event signature alone
 * is enough; V4 is filtered to the singleton PoolManager address since
 * that's the only contract that could emit it). Robinhood Chain's ~100ms
 * block time means "confirmed" is already about as early as "pending in
 * the mempool" would be on a slower chain, so this replaces mempool-
 * watching entirely: no provider-specific subscription method needed, and
 * it sees every swap regardless of which router/entrypoint was used --
 * including Universal Router, which swapDecoder.ts can't decode from
 * calldata alone.
 *
 * Approximation: the trader is taken from the Swap event's own party field
 * (`to` for V2, `recipient` for V3, `sender` for V4) rather than the
 * transaction's `from`, to avoid an extra RPC round trip per swap. This
 * matches the actual trader when a wallet swaps directly, but can be wrong
 * when routed through an intermediary that sets a different party --
 * V4's `sender` is *usually* the Universal Router itself (V4 funnels
 * almost everything through it), not the end wallet, so smart-money
 * matching is less reliable for V4 swaps specifically. "Buy pressure on a
 * hot token" signals still work fine either way; only wallet-identity-
 * dependent signals (smart_money_buy/composite) are affected.
 */
export function startSwapWatcher(onSwap: (swap: DecodedSwap) => void): () => void {
  const unwatchV2 = wsClient.watchEvent({
    event: uniswapV2SwapEventAbi[0],
    strict: true,
    onLogs: async (logs) => {
      for (const log of logs) {
        try {
          const pool = log.address.toLowerCase();
          const tokens = await getPoolTokens(pool);
          if (!tokens) continue;
          if (!isWethOrNative(tokens.token0) && !isWethOrNative(tokens.token1)) continue;

          const { amount0In, amount1In, amount0Out, amount1Out, to } = log.args;
          const wethIsToken0 = isWethOrNative(tokens.token0);
          const wethIn = wethIsToken0 ? amount0In : amount1In;
          const wethOut = wethIsToken0 ? amount0Out : amount1Out;
          const tokenAddress = wethIsToken0 ? tokens.token1 : tokens.token0;

          if (wethIn > 0n) {
            onSwap({
              txHash: log.transactionHash ?? "",
              trader: to.toLowerCase(),
              tokenAddress,
              side: "buy",
              ethAmount: Number(formatEther(wethIn)),
              router: pool,
            });
          } else if (wethOut > 0n) {
            onSwap({
              txHash: log.transactionHash ?? "",
              trader: to.toLowerCase(),
              tokenAddress,
              side: "sell",
              ethAmount: Number(formatEther(wethOut)),
              router: pool,
            });
          }
        } catch (err) {
          logger.warn(`swapWatcher v2: failed processing log: ${(err as Error).message}`);
        }
      }
    },
    onError: (err) => logger.error("swapWatcher v2 error:", err.message),
  });

  const unwatchV3 = wsClient.watchEvent({
    event: uniswapV3SwapEventAbi[0],
    strict: true,
    onLogs: async (logs) => {
      for (const log of logs) {
        try {
          const pool = log.address.toLowerCase();
          const tokens = await getPoolTokens(pool);
          if (!tokens) continue;
          if (!isWethOrNative(tokens.token0) && !isWethOrNative(tokens.token1)) continue;

          const { amount0, amount1, recipient } = log.args;
          const wethIsToken0 = isWethOrNative(tokens.token0);
          // Positive delta = pool's balance of that token increased, i.e. the
          // trader paid it in -- so a positive WETH delta means a buy.
          const wethDelta = wethIsToken0 ? amount0 : amount1;
          const tokenAddress = wethIsToken0 ? tokens.token1 : tokens.token0;
          if (wethDelta === 0n) continue;

          const side = wethDelta > 0n ? "buy" : "sell";
          const ethAmount = Number(formatEther(wethDelta < 0n ? -wethDelta : wethDelta));

          onSwap({
            txHash: log.transactionHash ?? "",
            trader: recipient.toLowerCase(),
            tokenAddress,
            side,
            ethAmount,
            router: pool,
          });
        } catch (err) {
          logger.warn(`swapWatcher v3: failed processing log: ${(err as Error).message}`);
        }
      }
    },
    onError: (err) => logger.error("swapWatcher v3 error:", err.message),
  });

  // V4 has no per-pool contract to filter logs by -- every pool's Swap
  // event comes from the singleton PoolManager, distinguished only by
  // poolId (a topic, not an address), so poolRegistry is keyed by poolId
  // here instead of a pool address.
  const unwatchV4 = wsClient.watchEvent({
    address: UNISWAP_V4_POOL_MANAGER as `0x${string}`,
    event: uniswapV4SwapEventAbi[0],
    strict: true,
    onLogs: async (logs) => {
      for (const log of logs) {
        try {
          const poolId = log.args.id;
          const tokens = await getPoolTokens(poolId);
          if (!tokens) continue;
          if (!isWethOrNative(tokens.token0) && !isWethOrNative(tokens.token1)) continue;

          const { amount0, amount1, sender } = log.args;
          const wethIsToken0 = isWethOrNative(tokens.token0);
          const wethDelta = wethIsToken0 ? amount0 : amount1;
          const tokenAddress = wethIsToken0 ? tokens.token1 : tokens.token0;
          if (wethDelta === 0n) continue;

          const side = wethDelta > 0n ? "buy" : "sell";
          const ethAmount = Number(formatEther(wethDelta < 0n ? -wethDelta : wethDelta));

          onSwap({
            txHash: log.transactionHash ?? "",
            trader: sender.toLowerCase(),
            tokenAddress,
            side,
            ethAmount,
            router: poolId,
          });
        } catch (err) {
          logger.warn(`swapWatcher v4: failed processing log: ${(err as Error).message}`);
        }
      }
    },
    onError: (err) => logger.error("swapWatcher v4 error:", err.message),
  });

  logger.info("Swap watcher started (confirmed Uniswap V2 + V3 + V4 Swap events, chain-wide).");
  return () => {
    unwatchV2();
    unwatchV3();
    unwatchV4();
  };
}
