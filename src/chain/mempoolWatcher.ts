import WebSocket from "ws";
import { config } from "../config";
import { logger } from "../utils/logger";
import { decodeSwap } from "../decode/swapDecoder";
import { KNOWN_ROUTERS } from "../decode/uniswapAbi";
import type { DecodedSwap } from "../types";

interface AlchemyPendingTx {
  hash: string;
  from: string;
  to: string | null;
  value: string; // hex wei
  input: string; // hex calldata
}

/**
 * Watches pending (unconfirmed) transactions to known Uniswap routers using
 * Alchemy's `alchemy_pendingTransactions` WS subscription, decodes swaps, and
 * calls back before the trade confirms -- this is what "early" means here:
 * seeing the trade in the mempool rather than waiting for the mined block.
 *
 * Uses the `ws` package explicitly rather than a global `WebSocket` -- that
 * global only exists on Node 22+, and this needs to run on any Node LTS
 * (20 included).
 *
 * NOTE: this subscription method is Alchemy-specific. If ALCHEMY_WS_URL is
 * pointed at a different provider, mempool visibility will be degraded or
 * unavailable -- swap this module out for that provider's pending-tx API.
 */
export function startMempoolWatcher(onSwap: (swap: DecodedSwap) => void): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let reconnectAttempt = 0;
  let subscriptionId: string | null = null;

  const routerAddresses = Object.values(KNOWN_ROUTERS);

  function connect() {
    if (stopped) return;
    socket = new WebSocket(config.rpc.wsUrl);

    socket.on("open", () => {
      reconnectAttempt = 0;
      logger.info("Mempool watcher connected.");
      socket?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_subscribe",
          params: ["alchemy_pendingTransactions", { toAddress: routerAddresses }],
        })
      );
    });

    socket.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === 1 && msg.result) {
          subscriptionId = msg.result;
          return;
        }
        if (msg.method !== "eth_subscription") return;
        const tx = msg.params?.result as AlchemyPendingTx | undefined;
        if (!tx || !tx.to) return;

        const decoded = decodeSwap({
          txHash: tx.hash,
          from: tx.from,
          to: tx.to,
          input: tx.input as `0x${string}`,
          valueWei: BigInt(tx.value || "0x0"),
        });
        if (decoded) onSwap(decoded);
      } catch (err) {
        logger.warn("mempoolWatcher: failed to process message:", (err as Error).message);
      }
    });

    socket.on("close", () => {
      subscriptionId = null;
      if (stopped) return;
      reconnectAttempt++;
      const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);
      logger.warn(`Mempool watcher disconnected, reconnecting in ${delay}ms...`);
      setTimeout(connect, delay);
    });

    socket.on("error", (err) => {
      logger.error("Mempool watcher socket error:", err.message);
    });
  }

  connect();

  return () => {
    stopped = true;
    socket?.close();
  };
}
