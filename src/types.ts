export type Address = string;

export interface TokenRecord {
  address: Address;
  symbol: string | null;
  name: string | null;
  firstSeenAt: number;
  initialMarketCapUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  isDexPaid: boolean;
  safetyScore: number | null;
  lastCheckedAt: number | null;
}

export type WalletTier = "candidate" | "smart_money" | "rejected";

export type WalletDataSource = "moralis" | "heuristic";

export interface WalletRecord {
  address: Address;
  score: number;
  winRate: number;
  realizedPnlEth: number;
  realizedPnlUsd: number | null;
  tradesCount: number;
  tier: WalletTier;
  dataSource: WalletDataSource;
  lastScoredAt: number | null;
}

export type TradeSide = "buy" | "sell";

export interface WalletTrade {
  id?: number;
  walletAddress: Address;
  tokenAddress: Address;
  side: TradeSide;
  amountEth: number;
  txHash: string;
  blockNumber: number;
  timestamp: number;
}

export type SignalType =
  | "smart_money_buy"
  | "hot_token_buy"
  | "new_dex_paid_low_mcap"
  | "fresh_pair"
  | "composite";

export interface SignalRecord {
  id?: number;
  tokenAddress: Address;
  walletAddress: Address | null;
  signalType: SignalType;
  score: number;
  message: string;
  createdAt: number;
  sentToTelegram: boolean;
}

export interface DecodedSwap {
  txHash: string;
  trader: Address;
  tokenAddress: Address;
  side: TradeSide;
  ethAmount: number | null;
  router: Address;
}

export interface CallRecord {
  tokenAddress: Address;
  symbol: string | null;
  callMarketCapUsd: number;
  callAt: number;
  peakMarketCapUsd: number;
  peakAt: number;
  lastMilestone: number;
  lastCheckedAt: number | null;
}

export interface DexscreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}
