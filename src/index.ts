import cron from "node-cron";
import { config } from "./config";
import { startSignalEngine } from "./signals/signalEngine";
import { checkCallMilestones } from "./signals/callTracker";
import { sendPlainMessage, sendSignalToTelegram } from "./telegram/bot";
import { discoverCandidateWallets } from "./wallets/candidateDiscovery";
import { walletsRepo } from "./db";
import { scoreWallet } from "./wallets/walletScorer";
import { resolveWeth } from "./chain/weth";
import { logger } from "./utils/logger";

async function runScoringPass() {
  const candidates = walletsRepo.byTier("candidate");
  logger.info(`Cron: scoring ${candidates.length} candidate wallet(s)...`);
  for (const wallet of candidates) {
    try {
      const scored = await scoreWallet(wallet.address);
      walletsRepo.upsert(scored);
    } catch (err) {
      logger.warn(`Cron scoring failed for ${wallet.address}: ${(err as Error).message}`);
    }
  }
}

async function main() {
  logger.info("Starting wallet-signal-bot (Robinhood Chain)...");

  await resolveWeth();

  const stopSignalEngine = startSignalEngine((signal) => {
    sendSignalToTelegram(signal);
  });

  // Periodically look for wallets that were early into tokens that pumped,
  // then score everything we've collected so far -- this is how the
  // smart-money list grows over time without any manual curation.
  cron.schedule("0 */6 * * *", async () => {
    try {
      const found = await discoverCandidateWallets();
      logger.info(`Cron: discovery found ${found.length} new candidate wallet(s).`);
    } catch (err) {
      logger.error("Cron discovery failed:", err);
    }
  });

  cron.schedule("30 */6 * * *", () => {
    runScoringPass().catch((err) => logger.error("Cron scoring pass failed:", err));
  });

  // Follows up on every token we've already alerted on: "called $91k -> $453k,
  // hit 5X" style milestone messages as the peak market cap since the call
  // crosses each new multiple.
  const callTrackingInterval = setInterval(() => {
    checkCallMilestones((message) => {
      sendPlainMessage(message).catch((err) =>
        logger.warn(`Failed to send call-milestone message: ${(err as Error).message}`)
      );
    }).catch((err) => logger.warn(`Call tracker pass failed: ${(err as Error).message}`));
  }, config.callTracking.checkIntervalMs);

  await sendPlainMessage("✅ wallet-signal-bot is online and watching Robinhood Chain.").catch(() => {
    logger.warn("Startup Telegram notification failed -- check TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID.");
  });

  process.on("SIGINT", () => {
    logger.info("Shutting down...");
    stopSignalEngine();
    clearInterval(callTrackingInterval);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopSignalEngine();
    clearInterval(callTrackingInterval);
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error("Fatal error on startup:", err);
  process.exit(1);
});
