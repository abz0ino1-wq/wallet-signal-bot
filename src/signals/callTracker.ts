import { config } from "../config";
import { callsRepo } from "../db";
import { getBestPair } from "../providers/dexscreener";
import { logger } from "../utils/logger";

const MILESTONES = [2, 3, 5, 10, 20, 50, 100, 200, 500, 1000];

function formatCompactUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

/**
 * "Called it" follow-up tracker: every token we've alerted on gets its
 * market cap at that moment recorded once (callsRepo.recordIfNew, called
 * from signalEngine.ts). This periodically re-checks each active call's
 * current market cap, tracks the peak since the call, and fires a
 * milestone message the first time the peak crosses each multiple (2x,
 * 5x, 10x, ...) -- mirroring the "🔥 $TOKEN hit 5X, called $91k -> $453k"
 * style GMGN-adjacent bots use.
 */
export async function checkCallMilestones(onMilestone: (message: string) => void): Promise<void> {
  const active = callsRepo.active(Date.now() - config.callTracking.trackWindowMs);
  if (active.length === 0) return;

  for (const call of active) {
    try {
      const pair = await getBestPair(config.chain.name, call.tokenAddress);
      const currentMcap = pair?.marketCap ?? pair?.fdv ?? null;
      if (!currentMcap) {
        callsRepo.touchChecked(call.tokenAddress, Date.now());
        continue;
      }

      const peakMcap = Math.max(call.peakMarketCapUsd, currentMcap);
      const peakMultiple = peakMcap / call.callMarketCapUsd;

      const crossed = MILESTONES.filter((m) => peakMultiple >= m && m > call.lastMilestone);
      if (crossed.length > 0) {
        const newMilestone = crossed[crossed.length - 1];
        const label = call.symbol ?? call.tokenAddress;
        onMilestone(
          `🔥 $${label} hit ${newMilestone}X\n` +
            `called ${formatCompactUsd(call.callMarketCapUsd)} → ${formatCompactUsd(peakMcap)}\n` +
            `peak since the call · dyor`
        );
        callsRepo.updatePeakAndMilestone(call.tokenAddress, peakMcap, Date.now(), newMilestone);
      } else if (peakMcap > call.peakMarketCapUsd) {
        callsRepo.updatePeakAndMilestone(call.tokenAddress, peakMcap, Date.now(), call.lastMilestone);
      } else {
        callsRepo.touchChecked(call.tokenAddress, Date.now());
      }
    } catch (err) {
      logger.warn(`callTracker: failed checking ${call.tokenAddress}: ${(err as Error).message}`);
    }
  }
}
