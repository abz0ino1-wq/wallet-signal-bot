import { formatEther } from "viem";
import { config } from "../config";
import { getInternalTransactionsByHash, getNormalTransactions } from "../providers/etherscan";
import { getWalletProfitabilitySummary } from "../providers/moralis";
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
 * Server-computed, USD-denominated PnL from Moralis -- this is the
 * "best available" scoring path and is preferred whenever MORALIS_API_KEY
 * is set. Scoring formula: win-rate proxy from buy/sell completion rate,
 * realized profit in USD, realized profit %, and trade-count activity, each
 * saturating so no single outlier metric dominates.
 */
async function scoreWalletViaMoralis(address: string): Promise<WalletRecord | null> {
  const summary = await getWalletProfitabilitySummary(address);
  if (!summary || summary.totalCountOfTrades === 0) return null;

  const completionRate = summary.totalBuys > 0 ? Math.min(1, summary.totalSells / summary.totalBuys) : 0;
  const profitUsdScore = 35 * Math.tanh(summary.totalRealizedProfitUsd / 2_000); // saturates ~+/-$2k
  const profitPctScore = 25 * Math.tanh(summary.totalRealizedProfitPercentage / 100); // saturates ~+/-100%
  const completionScore = 20 * completionRate; // 0-20, rewards wallets that actually close out positions
  const activityScore = Math.min(10, summary.totalCountOfTrades); // 0-10 bonus for sample size
  // Base of 30 (not 50) since profit/pct scores are signed +/-35/+/-25 around it;
  // a wallet with zero realized profit and no completed round trips lands near 30-40, not 50.
  const finalScore = Math.max(0, Math.min(100, 30 + profitUsdScore + profitPctScore + completionScore + activityScore));

  const tradesCount = summary.totalCountOfTrades;
  return {
    address: address.toLowerCase(),
    score: finalScore,
    winRate: completionRate,
    realizedPnlEth: 0,
    realizedPnlUsd: summary.totalRealizedProfitUsd,
    tradesCount,
    tier: tierFor(tradesCount, finalScore),
    dataSource: "moralis",
    lastScoredAt: Date.now(),
  };
}

/**
 * Heuristic profitability scoring from raw Etherscan calldata (no paid
 * indexer required). Per token, this treats a wallet's total buy-side ETH
 * spent vs total sell-side ETH received as one round trip -- accurate for
 * the classic degen pattern (ape in, dump the whole bag) but a
 * simplification for wallets that scale in/out of a position over time.
 * This is the fallback path used when Moralis isn't configured or fails.
 */
async function scoreWalletHeuristic(address: string): Promise<WalletRecord> {
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
        logger.warn(`scoreWalletHeuristic: failed to fetch internal txs for ${tx.hash}: ${(err as Error).message}`);
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

/**
 * Scores a wallet's trading profitability. Prefers Moralis' server-computed,
 * USD-denominated PnL when MORALIS_API_KEY is set; falls back to the local
 * Etherscan-calldata heuristic when Moralis is unset, errors, or has no data
 * for this wallet.
 */
export async function scoreWallet(address: string): Promise<WalletRecord> {
  if (config.moralis.apiKey) {
    try {
      const viaMoralis = await scoreWalletViaMoralis(address);
      if (viaMoralis) return viaMoralis;
    } catch (err) {
      logger.warn(`scoreWallet: Moralis scoring failed for ${address}, falling back: ${(err as Error).message}`);
    }
  }
  return scoreWalletHeuristic(address);
}
