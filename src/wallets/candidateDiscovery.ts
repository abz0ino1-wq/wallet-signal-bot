import { config } from "../config";
import { tokensRepo, walletsRepo } from "../db";
import { getBestPair } from "../providers/dexscreener";
import { getEarliestTokenRecipients } from "../providers/etherscan";
import { logger } from "../utils/logger";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Scans recently-discovered tokens for ones that pumped (current mcap >=
 * minPumpMultiple x its mcap when first seen), then pulls the earliest
 * on-chain recipients of that token as candidate wallets -- the working
 * theory being that consistently early buyers of pumps are worth tracking.
 * Newly found candidates are persisted at tier='candidate' pending scoring.
 */
export async function discoverCandidateWallets(): Promise<string[]> {
  const recent = tokensRepo
    .recentlyDiscovered(Date.now() - THIRTY_DAYS_MS)
    .filter((t) => t.initialMarketCapUsd && t.initialMarketCapUsd > 0)
    .slice(0, config.discovery.tokenSampleSize);

  const newCandidates = new Set<string>();

  for (const token of recent) {
    try {
      const pair = await getBestPair(config.chain.name, token.address);
      const currentMcap = pair?.marketCap ?? pair?.fdv ?? null;
      if (!currentMcap || !token.initialMarketCapUsd) continue;

      const multiple = currentMcap / token.initialMarketCapUsd;
      tokensRepo.upsert({
        ...token,
        marketCapUsd: currentMcap,
        liquidityUsd: pair?.liquidity?.usd ?? token.liquidityUsd,
        lastCheckedAt: Date.now(),
      });

      if (multiple < config.discovery.minPumpMultiple) continue;

      logger.info(`Discovery: ${token.address} pumped ${multiple.toFixed(1)}x -- pulling early buyers.`);
      const recipients = await getEarliestTokenRecipients(token.address, 50);
      for (const tx of recipients) {
        const wallet = tx.to?.toLowerCase();
        if (!wallet || wallet === ZERO_ADDRESS) continue;
        if (walletsRepo.get(wallet)) continue; // already known, leave its tier/score alone
        walletsRepo.upsert({
          address: wallet,
          score: 0,
          winRate: 0,
          realizedPnlEth: 0,
          tradesCount: 0,
          tier: "candidate",
          lastScoredAt: null,
        });
        newCandidates.add(wallet);
      }
    } catch (err) {
      logger.warn(`Discovery: failed processing ${token.address}: ${(err as Error).message}`);
    }
  }

  return [...newCandidates];
}
