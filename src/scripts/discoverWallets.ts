import { discoverCandidateWallets } from "../wallets/candidateDiscovery";
import { logger } from "../utils/logger";

discoverCandidateWallets()
  .then((found) => {
    logger.info(`Discovery run complete. ${found.length} new candidate wallet(s):`, found);
    process.exit(0);
  })
  .catch((err) => {
    logger.error("Discovery run failed:", err);
    process.exit(1);
  });
