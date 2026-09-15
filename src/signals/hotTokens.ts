import { config } from "../config";
import { tokensRepo } from "../db";
import { getBestPair, getLatestBoostedTokens, getTopBoostedTokens } from "../providers/dexscreener";
import { getTokenSafety } from "../providers/goplus";
import type { TokenRecord } from "../types";
import { logger } from "../utils/logger";

/**
 * "Dex paid" + low-market-cap token watchlist: pulls Dexscreener's boosted
 * (paid-promotion) token feed, filters to Ethereum mainnet tokens under the
 * configured market-cap/liquidity thresholds, and screens out obvious
 * scams/honeypots via GoPlus before a token is considered "hot" (i.e.
 * eligible to trigger signals).
 */
export async function refreshHotTokens(): Promise<Map<string, TokenRecord>> {
  const hot = new Map<string, TokenRecord>();

  const [latest, top] = await Promise.all([
    getLatestBoostedTokens().catch(() => []),
    getTopBoostedTokens().catch(() => []),
  ]);

  const ethTokens = [...latest, ...top].filter((t) => t.chainId === "ethereum");
  const seen = new Set<string>();

  for (const boosted of ethTokens) {
    const address = boosted.tokenAddress.toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);

    try {
      const pair = await getBestPair("ethereum", address);
      const marketCapUsd = pair?.marketCap ?? pair?.fdv ?? null;
      const liquidityUsd = pair?.liquidity?.usd ?? null;

      if (!marketCapUsd || marketCapUsd > config.thresholds.maxMarketCapUsd) continue;
      if (!liquidityUsd || liquidityUsd < config.thresholds.minLiquidityUsd) continue;

      const safety = await getTokenSafety(address);
      if (safety.isHoneypot || safety.score < config.thresholds.minSafetyScore) {
        logger.info(`Hot tokens: skipping ${address} (safety score ${safety.score}: ${safety.reasons.join(",")})`);
        continue;
      }

      const existing = tokensRepo.get(address);
      const record: TokenRecord = {
        address,
        symbol: pair?.baseToken?.symbol ?? existing?.symbol ?? null,
        name: pair?.baseToken?.name ?? existing?.name ?? null,
        firstSeenAt: existing?.firstSeenAt ?? Date.now(),
        initialMarketCapUsd: existing?.initialMarketCapUsd ?? marketCapUsd,
        marketCapUsd,
        liquidityUsd,
        isDexPaid: true,
        safetyScore: safety.score,
        lastCheckedAt: Date.now(),
      };
      tokensRepo.upsert(record);
      hot.set(address, record);
    } catch (err) {
      logger.warn(`Hot tokens: failed processing ${address}: ${(err as Error).message}`);
    }
  }

  logger.info(`Hot tokens refreshed: ${hot.size} dex-paid low-mcap token(s) passing filters.`);
  return hot;
}
