import { config } from "../config";
import { tokensRepo } from "../db";
import { getBestPair, getLatestBoostedTokens, getTopBoostedTokens } from "../providers/dexscreener";
import { getTokenSafety } from "../providers/scanhood";
import type { TokenRecord } from "../types";
import { logger } from "../utils/logger";

/**
 * "Dex paid" + low-market-cap token watchlist: pulls Dexscreener's boosted
 * (paid-promotion) token feed, filters to this chain's tokens inside the
 * configured market-cap band with real liquidity and 24h volume, still
 * under the max age (a token can launch, sit for hours/days, then start
 * paying for a boost -- age caps that out so this stays about genuinely
 * fresh tokens, not just currently-boosted ones), and screens out obvious
 * scams/honeypots via ScanHood before a token is considered "hot" (i.e.
 * eligible to trigger signals).
 */
export async function refreshHotTokens(): Promise<Map<string, TokenRecord>> {
  const hot = new Map<string, TokenRecord>();

  const [latest, top] = await Promise.all([
    getLatestBoostedTokens().catch(() => []),
    getTopBoostedTokens().catch(() => []),
  ]);

  const chainTokens = [...latest, ...top].filter((t) => t.chainId === config.chain.name);
  const seen = new Set<string>();
  let skippedMcap = 0;
  let skippedLiquidity = 0;
  let skippedVolume = 0;
  let skippedAge = 0;
  let skippedSafety = 0;

  logger.info(
    `Hot tokens: fetched ${latest.length} latest-boosted + ${top.length} top-boosted (${chainTokens.length} on ${config.chain.name}).`
  );

  for (const boosted of chainTokens) {
    const address = boosted.tokenAddress.toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);

    try {
      const pair = await getBestPair(config.chain.name, address);
      const marketCapUsd = pair?.marketCap ?? pair?.fdv ?? null;
      const liquidityUsd = pair?.liquidity?.usd ?? null;
      const volumeUsd = pair?.volume?.h24 ?? null;

      if (!marketCapUsd || marketCapUsd < config.thresholds.minMarketCapUsd || marketCapUsd > config.thresholds.maxMarketCapUsd) {
        skippedMcap++;
        continue;
      }
      if (!liquidityUsd || liquidityUsd < config.thresholds.minLiquidityUsd) {
        skippedLiquidity++;
        continue;
      }
      if (!volumeUsd || volumeUsd < config.thresholds.minVolumeUsd) {
        skippedVolume++;
        continue;
      }
      if (pair?.pairCreatedAt) {
        const ageHours = (Date.now() - pair.pairCreatedAt) / (60 * 60 * 1000);
        if (ageHours > config.thresholds.maxTokenAgeHours) {
          skippedAge++;
          continue;
        }
      }

      const safety = await getTokenSafety(address);
      if (safety.isHoneypot || safety.score < config.thresholds.minSafetyScore) {
        skippedSafety++;
        const note = safety.unverifiable ? "not yet verifiable, will recheck next refresh" : safety.reasons.join(",");
        logger.info(`Hot tokens: skipping ${address} (safety score ${safety.score}: ${note})`);
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

  logger.info(
    `Hot tokens refreshed: ${hot.size} passing filters (skipped: ${skippedMcap} mcap, ${skippedLiquidity} liquidity, ${skippedVolume} volume, ${skippedAge} age, ${skippedSafety} safety).`
  );
  return hot;
}
