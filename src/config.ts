import "dotenv/config";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. See .env.example.`);
  }
  return value;
}

export const config = {
  chain: {
    id: 4663,
    name: "robinhood",
  },
  rpc: {
    // Alchemy officially supports Robinhood Chain; the exact subdomain
    // wasn't independently verifiable from this environment, so this
    // follows Alchemy's standard "<chain>-mainnet.g.alchemy.com" pattern.
    // If your Alchemy dashboard shows a different URL for your Robinhood
    // Chain app, set ALCHEMY_WS_URL/ALCHEMY_HTTP_URL explicitly and these
    // are ignored.
    get wsUrl(): string {
      if (process.env.ALCHEMY_WS_URL) return process.env.ALCHEMY_WS_URL;
      return `wss://robinhood-mainnet.g.alchemy.com/v2/${requireEnv("ALCHEMY_API_KEY")}`;
    },
    get httpUrl(): string {
      if (process.env.ALCHEMY_HTTP_URL) return process.env.ALCHEMY_HTTP_URL;
      return `https://robinhood-mainnet.g.alchemy.com/v2/${requireEnv("ALCHEMY_API_KEY")}`;
    },
  },
  blockscout: {
    // Robinhood Chain's block explorer is Blockscout-based and exposes a
    // free, keyless Etherscan-compatible API at this base URL (confirmed
    // via viem's built-in chain definition).
    baseUrl: process.env.BLOCKSCOUT_API_URL || "https://robinhoodchain.blockscout.com/api",
  },
  telegram: {
    get botToken(): string {
      return requireEnv("TELEGRAM_BOT_TOKEN");
    },
    get chatId(): string {
      return requireEnv("TELEGRAM_CHAT_ID");
    },
  },
  db: {
    path: process.env.DB_PATH || "./data/wallet-signal-bot.sqlite",
  },
  thresholds: {
    maxMarketCapUsd: envInt("MAX_MARKET_CAP_USD", 1_000_000),
    minLiquidityUsd: envInt("MIN_LIQUIDITY_USD", 5_000),
    minSafetyScore: envInt("MIN_SAFETY_SCORE", 60),
    minWalletScore: envInt("MIN_WALLET_SCORE", 60),
    // Separate (lower) bar for brand-new pairs: a token seconds old won't yet
    // have the liquidity an established "hot" token would.
    minFreshPairLiquidityUsd: envInt("MIN_FRESH_PAIR_LIQUIDITY_USD", 2_000),
  },
  freshPair: {
    // How long to wait after a new pair is created before checking its
    // liquidity/safety -- Dexscreener often hasn't indexed a pool yet in the
    // first few seconds after creation.
    checkDelayMs: envInt("FRESH_PAIR_CHECK_DELAY_MS", 15_000),
  },
  discovery: {
    minPumpMultiple: envInt("DISCOVERY_MIN_PUMP_MULTIPLE", 3),
    tokenSampleSize: envInt("DISCOVERY_TOKEN_SAMPLE_SIZE", 25),
  },
  scanhood: {
    baseUrl: process.env.SCANHOOD_API_URL || "https://api.scanhood.xyz",
  },
  // Optional override: skips the on-chain WETH() lookup at startup (see
  // src/chain/weth.ts) if you already know the wrapped-native address.
  wethOverride: process.env.WETH_ADDRESS?.toLowerCase() || null,
} as const;
