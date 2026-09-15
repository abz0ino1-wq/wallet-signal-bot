import { config } from "../config";
import { fetchJson } from "../utils/http";
import { logger } from "../utils/logger";

export interface TokenSafety {
  score: number; // 0-100, higher is safer
  reasons: string[];
  isHoneypot: boolean;
  buyTaxPct: number;
  sellTaxPct: number;
}

interface ScanHoodResponse {
  verdict?: string; // expected: "PASS" | "CAUTION" | "DANGER"
  is_honeypot?: boolean;
  buy_tax_pct?: number;
  sell_tax_pct?: number;
  lp_locked?: boolean;
  contract_verified?: boolean;
  flags?: string[];
  [key: string]: unknown;
}

/**
 * GoPlus does not support Robinhood Chain (chain 4663 is explicitly
 * rejected), so this uses ScanHood -- a free, no-key scanner built
 * specifically for this chain that simulates an actual buy+sell round trip
 * on-chain to detect honeypots.
 *
 * IMPORTANT: the exact request/response contract below is a best-effort
 * guess (this environment could not reach scanhood.xyz to verify it
 * directly). It fails SAFE: any error, unreachable endpoint, or
 * unrecognized response shape returns score 0 / isHoneypot true, so a
 * wrong guess here means "no fresh_pair alerts fire" rather than "unsafe
 * tokens get alerted anyway." If you see `scanhood_unverifiable` in the
 * logs consistently, that's this contract being wrong, not the tokens
 * being unsafe -- check scanhood.xyz's actual API docs and fix the URL
 * pattern / field names below (your VPS can reach it even though this dev
 * environment couldn't).
 */
export async function getTokenSafety(tokenAddress: string): Promise<TokenSafety> {
  const url = `${config.scanhood.baseUrl}/v1/scan/${tokenAddress}`;

  try {
    const data = await fetchJson<ScanHoodResponse>(url, { timeoutMs: 8_000, retries: 1 });

    if (typeof data.verdict !== "string") {
      logger.warn(`ScanHood: unrecognized response shape for ${tokenAddress}: ${JSON.stringify(data).slice(0, 200)}`);
      return { score: 0, reasons: ["scanhood_unverifiable"], isHoneypot: true, buyTaxPct: 0, sellTaxPct: 0 };
    }

    const verdict = data.verdict.toUpperCase();
    const isHoneypot = data.is_honeypot === true || verdict === "DANGER";
    const buyTaxPct = data.buy_tax_pct ?? 0;
    const sellTaxPct = data.sell_tax_pct ?? 0;
    const reasons: string[] = Array.isArray(data.flags) ? [...data.flags] : [];

    let score = verdict === "PASS" ? 90 : verdict === "CAUTION" ? 50 : 0;
    if (data.lp_locked === false) {
      score -= 15;
      reasons.push("lp_not_locked");
    }
    if (data.contract_verified === false) {
      score -= 15;
      reasons.push("contract_not_verified");
    }
    if (buyTaxPct > 10) {
      score -= 15;
      reasons.push(`high_buy_tax_${buyTaxPct.toFixed(0)}pct`);
    }
    if (sellTaxPct > 10) {
      score -= 20;
      reasons.push(`high_sell_tax_${sellTaxPct.toFixed(0)}pct`);
    }
    score = Math.max(0, Math.min(100, score));

    return { score, reasons, isHoneypot, buyTaxPct, sellTaxPct };
  } catch (err) {
    logger.warn(`ScanHood: request failed for ${tokenAddress}: ${(err as Error).message}`);
    return { score: 0, reasons: ["scanhood_unreachable"], isHoneypot: true, buyTaxPct: 0, sellTaxPct: 0 };
  }
}
