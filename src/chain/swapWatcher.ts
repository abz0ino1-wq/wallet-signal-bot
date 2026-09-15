import { formatEther } from "viem";
import { wsClient } from "./viemClient";
import { uniswapV2SwapEventAbi, uniswapV3SwapEventAbi } from "../decode/uniswapAbi";
import { getPoolTokens } from "./poolRegistry";
import { getWeth } from "./weth";
import { logger } from "../utils/logger";
import type { DecodedSwap } from "../types";

/**
 * Watches confirmed Swap events chain-wide via a topic-only WS subscription
 * (no per-pool address filter -- Uniswap's Swap event signature alone is
 * enough). Robinhood Chain's ~100ms block time means "confirmed" is already
 * about as early as "pending in the mempool" would be on a slower chain, so
 * this replaces mempool-watching entirely: it needs no provider-specific
 * subscription method (standard eth_subscribe logs works with any WS RPC),
 * and it sees every swap regardless of which router/entrypoint was used --
 * including Universal Router, which swapDecoder.ts can't decode from
 * calldata alone.
 *
 * Approximation: the trader is taken from the Swap event's `to` (V2) /
 * `recipient` (V3) field rather than the transaction's `from`, to avoid an
 * extra RPC round trip per swap. This matches the actual trader in the
 * common case (a wallet swapping directly), but can be wrong for swaps
 * routed through an intermediary contract that sets a different recipient.
 */
export function startSwapWatcher(onSwap: (swap: DecodedSwap) => void): () => void {
  const weth = getWeth();

  const unwatchV2 = wsClient.watchEvent({
    event: uniswapV2SwapEventAbi[0],
    strict: true,
    onLogs: async (logs) => {
      for (const log of logs) {
        try {
          const pool = log.address.toLowerCase();
          const tokens = await getPoolTokens(pool);
          if (!tokens) continue;
          if (tokens.token0 !== weth && tokens.token1 !== weth) continue; // not WETH-paired, skip

          const { amount0In, amount1In, amount0Out, amount1Out, to } = log.args;
          const wethIsToken0 = tokens.token0 === weth;
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
          if (tokens.token0 !== weth && tokens.token1 !== weth) continue;

          const { amount0, amount1, recipient } = log.args;
          const wethIsToken0 = tokens.token0 === weth;
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

  logger.info("Swap watcher started (confirmed Uniswap V2 + V3 Swap events, chain-wide).");
  return () => {
    unwatchV2();
    unwatchV3();
  };
}
