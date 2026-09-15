import { walletsRepo } from "../db";
import { scoreWallet } from "../wallets/walletScorer";
import { logger } from "../utils/logger";

async function main() {
  const candidates = walletsRepo.byTier("candidate");
  logger.info(`Scoring ${candidates.length} candidate wallet(s)...`);

  let promoted = 0;
  for (const wallet of candidates) {
    try {
      const scored = await scoreWallet(wallet.address);
      walletsRepo.upsert(scored);
      if (scored.tier === "smart_money") {
        promoted++;
        logger.info(`Promoted ${wallet.address} to smart_money (score ${scored.score.toFixed(1)})`);
      }
    } catch (err) {
      logger.warn(`Failed scoring ${wallet.address}: ${(err as Error).message}`);
    }
  }
  logger.info(`Scoring run complete. ${promoted} wallet(s) promoted to smart_money.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error("Scoring run failed:", err);
    process.exit(1);
  });
