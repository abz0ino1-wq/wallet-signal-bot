import { config } from "../config";
import { tokensRepo, walletsRepo } from "../db";
import { getBestPair } from "../providers/dexscreener";
import { getEarliestTokenRecipients } from "../providers/etherscan";
import { getTopProfitableWalletsPerToken } from "../providers/moralis";
import { logger } from "../utils/logger";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function addCandidateWallet(wallet: string, into: Set<string>) {
  if (walletsRepo.get(wallet)) return; // already known, leave its tier/score alone
  walletsRepo.upsert({
    address: wallet,
    score: 0,
    winRate: 0,
    realizedPnlEth: 0,
    realizedPnlUsd: null,
    tradesCount: 0,
    tier: "candidate",
    dataSource: "heuristic",
    lastScoredAt: null,
  });
  into.add(wallet);
}

/**
 * Scans recently-discovered tokens for ones that pumped (current mcap >=
 * minPumpMultiple x its mcap when first seen), then finds candidate wallets
 * to track for that token. When MORALIS_API_KEY is set, this uses Moralis'
 * top-profitable-wallets-per-token endpoint -- directly surfacing wallets
 * that were actually profitable on this token, which is strictly better
 * than a proxy signal. Falls back to pulling the token's earliest on-chain
 * recipients via Etherscan (the working theory there being that
 * consistently early buyers of pumps are worth tracking) when Moralis is
 * unset or returns nothing. Newly found candidates are persisted at
 * tier='candidate' pending scoring.
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

      logger.info(`Discovery: ${token.address} pumped ${multiple.toFixed(1)}x -- finding candidate wallets.`);

      const topProfitable = await getTopProfitableWalletsPerToken(token.address, { limit: 25 });
      if (topProfitable && topProfitable.length > 0) {
        for (const w of topProfitable) addCandidateWallet(w.walletAddress, newCandidates);
        continue;
      }

      // Moralis unset/unavailable for this token -- fall back to earliest recipients.
      const recipients = await getEarliestTokenRecipients(token.address, 50);
      for (const tx of recipients) {
        const wallet = tx.to?.toLowerCase();
        if (!wallet || wallet === ZERO_ADDRESS) continue;
        addCandidateWallet(wallet, newCandidates);
      }
    } catch (err) {
      logger.warn(`Discovery: failed processing ${token.address}: ${(err as Error).message}`);
    }
  }

  return [...newCandidates];
}
