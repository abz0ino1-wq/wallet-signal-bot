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
    id: 1,
    name: "ethereum",
  },
  rpc: {
    // Alchemy key is used to build WS/HTTP URLs unless explicit overrides are given.
    get wsUrl(): string {
      if (process.env.ALCHEMY_WS_URL) return process.env.ALCHEMY_WS_URL;
      return `wss://eth-mainnet.g.alchemy.com/v2/${requireEnv("ALCHEMY_API_KEY")}`;
    },
    get httpUrl(): string {
      if (process.env.ALCHEMY_HTTP_URL) return process.env.ALCHEMY_HTTP_URL;
      return `https://eth-mainnet.g.alchemy.com/v2/${requireEnv("ALCHEMY_API_KEY")}`;
    },
  },
  etherscan: {
    get apiKey(): string {
      return requireEnv("ETHERSCAN_API_KEY");
    },
    baseUrl: "https://api.etherscan.io/v2/api",
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
  },
  discovery: {
    minPumpMultiple: envInt("DISCOVERY_MIN_PUMP_MULTIPLE", 3),
    tokenSampleSize: envInt("DISCOVERY_TOKEN_SAMPLE_SIZE", 25),
  },
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase(),
} as const;
