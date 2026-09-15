import { formatEther } from "viem";
import { config } from "../config";
import { getInternalTransactionsByHash, getNormalTransactions } from "../providers/blockscout";
import { decodeSwap } from "../decode/swapDecoder";
import { KNOWN_ROUTERS } from "../decode/uniswapAbi";
import { walletTradesRepo } from "../db";
import type { WalletRecord, WalletTrade } from "../types";
import { logger } from "../utils/logger";

const ROUTER_SET = new Set<string>(Object.values(KNOWN_ROUTERS));

function tierFor(tradesCount: number, score: number): WalletRecord["tier"] {
  if (tradesCount < 3) return "candidate";
  return score >= config.thresholds.minWalletScore ? "smart_money" : "rejected";
}

/**
 * Heuristic profitability scoring from raw Blockscout calldata (no paid
 * indexer required -- Robinhood Chain is too new for Moralis/Nansen/etc to
 * cover). Per token, this treats a wallet's total buy-side ETH spent vs
 * total sell-side ETH received as one round trip -- accurate for the
 * classic degen pattern (ape in, dump the whole bag) but a simplification
 * for wallets that scale in/out of a position over time. It also only sees
 * trades routed through V2 Router02 or V3 SwapRouter02 -- trades made via
 * Universal Router (the *preferred* entrypoint on this chain) are invisible
 * to this scorer, so wallet scores here are a lower bound, not exact PnL.
 */
export async function scoreWallet(address: string): Promise<WalletRecord> {
  const txs = await getNormalTransactions(address);
  const swapTxs = txs.filter((t) => t.isError === "0" && t.to && ROUTER_SET.has(t.to.toLowerCase()));

  const perToken = new Map<string, { buyEth: number; sellEth: number; trades: number }>();

  for (const tx of swapTxs) {
    const decoded = decodeSwap({
      txHash: tx.hash,
      from: tx.from,
      to: tx.to,
      input: tx.input as `0x${string}`,
      valueWei: BigInt(tx.value || "0"),
    });
    if (!decoded) continue;

    let ethAmount = decoded.ethAmount;
    if (decoded.side === "sell" && ethAmount === null) {
      try {
        const internal = await getInternalTransactionsByHash(tx.hash);
        const received = internal
          .filter((i) => i.to.toLowerCase() === address.toLowerCase())
          .reduce((sum, i) => sum + Number(formatEther(BigInt(i.value || "0"))), 0);
        ethAmount = received;
      } catch (err) {
        logger.warn(`scoreWallet: failed to fetch internal txs for ${tx.hash}: ${(err as Error).message}`);
        ethAmount = 0;
      }
    }
    ethAmount = ethAmount ?? 0;

    const trade: WalletTrade = {
      walletAddress: address,
      tokenAddress: decoded.tokenAddress,
      side: decoded.side,
      amountEth: ethAmount,
      txHash: tx.hash,
      blockNumber: Number(tx.blockNumber),
      timestamp: Number(tx.timeStamp),
    };
    walletTradesRepo.insert(trade);

    const bucket = perToken.get(decoded.tokenAddress) ?? { buyEth: 0, sellEth: 0, trades: 0 };
    if (decoded.side === "buy") bucket.buyEth += ethAmount;
    else bucket.sellEth += ethAmount;
    bucket.trades += 1;
    perToken.set(decoded.tokenAddress, bucket);
  }

  let wins = 0;
  let tokensWithSells = 0;
  let totalRealizedPnlEth = 0;
  let tradesCount = 0;

  for (const bucket of perToken.values()) {
    tradesCount += bucket.trades;
    if (bucket.sellEth > 0) {
      tokensWithSells += 1;
      const pnl = bucket.sellEth - bucket.buyEth;
      totalRealizedPnlEth += pnl;
      if (pnl > 0) wins += 1;
    }
  }

  const winRate = tokensWithSells > 0 ? wins / tokensWithSells : 0;
  const pnlScore = 40 * Math.tanh(totalRealizedPnlEth / 3); // saturates around +/-3 ETH
  const activityScore = Math.min(10, tradesCount);
  const rawScore = winRate * 50 + pnlScore + activityScore;
  const score = Math.max(0, Math.min(100, rawScore));

  return {
    address: address.toLowerCase(),
    score,
    winRate,
    realizedPnlEth: totalRealizedPnlEth,
    realizedPnlUsd: null,
    tradesCount,
    tier: tierFor(tradesCount, score),
    dataSource: "heuristic",
    lastScoredAt: Date.now(),
  };
}
