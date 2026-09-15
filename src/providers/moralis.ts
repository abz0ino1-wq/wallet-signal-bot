import { config } from "../config";
import { fetchJson } from "../utils/http";

const CHAIN = "eth";

export interface WalletProfitabilitySummary {
  totalCountOfTrades: number;
  totalTradeVolumeUsd: number;
  totalRealizedProfitUsd: number;
  totalRealizedProfitPercentage: number;
  totalBuys: number;
  totalSells: number;
  totalBoughtVolumeUsd: number;
  totalSoldVolumeUsd: number;
}

export interface TopProfitableWallet {
  walletAddress: string;
  totalRealizedProfitUsd: number;
  totalRealizedProfitPercentage: number | null;
  countOfTrades: number | null;
}

function headers() {
  const apiKey = config.moralis.apiKey;
  if (!apiKey) throw new Error("MORALIS_API_KEY not set");
  return { accept: "application/json", "X-API-Key": apiKey };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Server-computed wallet PnL from Moralis (confirmed endpoint/fields as of
 * writing: https://deep-index.moralis.io/api/v2.2/wallets/{address}/profitability/summary).
 * Returns null if Moralis isn't configured or the call fails -- callers
 * should fall back to the local heuristic scorer in that case.
 */
export async function getWalletProfitabilitySummary(
  address: string,
  days: "all" | "7" | "30" | "60" | "90" = "all"
): Promise<WalletProfitabilitySummary | null> {
  if (!config.moralis.apiKey) return null;
  try {
    const url = `${config.moralis.baseUrl}/wallets/${address}/profitability/summary?chain=${CHAIN}&days=${days}`;
    const data = await fetchJson<Record<string, unknown>>(url, { headers: headers() });
    return {
      totalCountOfTrades: num(data.total_count_of_trades),
      totalTradeVolumeUsd: num(data.total_trade_volume),
      totalRealizedProfitUsd: num(data.total_realized_profit_usd),
      totalRealizedProfitPercentage: num(data.total_realized_profit_percentage),
      totalBuys: num(data.total_buys),
      totalSells: num(data.total_sells),
      totalBoughtVolumeUsd: num(data.total_bought_volume_usd),
      totalSoldVolumeUsd: num(data.total_sold_volume_usd),
    };
  } catch {
    return null;
  }
}

/**
 * Top profitable wallets for a specific token. Endpoint path is Moralis'
 * documented naming convention for per-token analytics
 * (/erc20/{address}/top-profitable-wallets) but is less thoroughly verified
 * than the wallet-summary endpoint above -- this is wrapped defensively and
 * callers must treat a null/empty result as "unavailable, use the fallback
 * discovery method" rather than "this token has no profitable wallets".
 */
export async function getTopProfitableWalletsPerToken(
  tokenAddress: string,
  opts: { days?: "all" | "7" | "30" | "60" | "90"; limit?: number } = {}
): Promise<TopProfitableWallet[] | null> {
  if (!config.moralis.apiKey) return null;
  const { days = "all", limit = 20 } = opts;
  try {
    const url = `${config.moralis.baseUrl}/erc20/${tokenAddress}/top-profitable-wallets?chain=${CHAIN}&days=${days}&limit=${limit}`;
    const data = await fetchJson<{ result?: Record<string, unknown>[] } | Record<string, unknown>[]>(url, {
      headers: headers(),
    });
    const rows = Array.isArray(data) ? data : data.result ?? [];
    if (!Array.isArray(rows)) return null;

    return rows
      .map((row) => {
        const wallet = String(row.wallet_address ?? row.address ?? "").toLowerCase();
        if (!wallet) return null;
        return {
          walletAddress: wallet,
          totalRealizedProfitUsd: num(row.total_realized_profit_usd ?? row.realized_profit_usd),
          totalRealizedProfitPercentage:
            row.total_realized_profit_percentage != null ? num(row.total_realized_profit_percentage) : null,
          countOfTrades: row.count_of_trades != null ? num(row.count_of_trades) : null,
        };
      })
      .filter((r): r is TopProfitableWallet => r !== null);
  } catch {
    return null;
  }
}
