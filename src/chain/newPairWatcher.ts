import { wsClient } from "./viemClient";
import {
  UNISWAP_V2_FACTORY,
  UNISWAP_V3_FACTORY,
  uniswapV2PairCreatedAbi,
  uniswapV3PoolCreatedAbi,
} from "../decode/uniswapAbi";
import { getWeth } from "./weth";
import { logger } from "../utils/logger";

export interface NewPairEvent {
  dex: "uniswap_v2" | "uniswap_v3";
  token0: string;
  token1: string;
  pairOrPool: string;
  txHash: string;
  blockNumber: bigint | null;
}

/** The non-WETH side of a new pair, i.e. the token that just got a fresh market. */
export function candidateTokenFromPair(ev: NewPairEvent): string | null {
  const weth = getWeth();
  const t0 = ev.token0.toLowerCase();
  const t1 = ev.token1.toLowerCase();
  if (t0 === weth) return t1;
  if (t1 === weth) return t0;
  return null; // not WETH-paired -- harder to price, skip for now
}

export function startNewPairWatcher(onNewPair: (ev: NewPairEvent) => void): () => void {
  const unwatchV2 = wsClient.watchEvent({
    address: UNISWAP_V2_FACTORY as `0x${string}`,
    event: uniswapV2PairCreatedAbi[0],
    strict: true,
    onLogs: (logs) => {
      for (const log of logs) {
        onNewPair({
          dex: "uniswap_v2",
          token0: log.args.token0,
          token1: log.args.token1,
          pairOrPool: log.args.pair,
          txHash: log.transactionHash ?? "",
          blockNumber: log.blockNumber ?? null,
        });
      }
    },
    onError: (err) => logger.error("newPairWatcher v2 error:", err.message),
  });

  const unwatchV3 = wsClient.watchEvent({
    address: UNISWAP_V3_FACTORY as `0x${string}`,
    event: uniswapV3PoolCreatedAbi[0],
    strict: true,
    onLogs: (logs) => {
      for (const log of logs) {
        onNewPair({
          dex: "uniswap_v3",
          token0: log.args.token0,
          token1: log.args.token1,
          pairOrPool: log.args.pool,
          txHash: log.transactionHash ?? "",
          blockNumber: log.blockNumber ?? null,
        });
      }
    },
    onError: (err) => logger.error("newPairWatcher v3 error:", err.message),
  });

  logger.info("New-pair watcher started (Uniswap V2 + V3 factories).");
  return () => {
    unwatchV2();
    unwatchV3();
  };
}
