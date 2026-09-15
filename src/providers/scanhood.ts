import { config } from "../config";
import { fetchJson } from "../utils/http";
import { logger } from "../utils/logger";

export interface TokenSafety {
  score: number; // 0-100, higher is safer
  reasons: string[];
  isHoneypot: boolean;
  buyTaxPct: number;
  sellTaxPct: number;
  // True when the only reason this isn't PASS is that ScanHood couldn't run
  // its sell simulation yet (too new / no pool), not an actual risk flag --
  // callers should retry later rather than treat this as "verified risky."
  unverifiable: boolean;
}

interface ScanHoodResponse {
  verdict?: string; // "PASS" | "CAUTION" | "DANGER"
  sellable?: boolean; // honeypot buy+sell simulation result, right now
  lp?: { status?: string; locked?: boolean };
  lp_status?: string;
  // Elements are sometimes plain strings, sometimes objects (e.g.
  // {code, message}) -- flagToString() below normalizes either shape.
  flags?: unknown[];
  [key: string]: unknown;
}

function flagToString(flag: unknown): string {
  if (typeof flag === "string") return flag;
  if (flag && typeof flag === "object") {
    const obj = flag as Record<string, unknown>;
    const label = obj.message ?? obj.code ?? obj.type ?? obj.name;
    if (typeof label === "string") return label;
  }
  return JSON.stringify(flag);
}

// Confirmed via https://scanhood.xyz/llms.txt (ScanHood's own agent-oriented
// API docs). Reasonable-citizen throttle per their "rate limits apply" note.
let lastCallAt = 0;
async function throttle(minGapMs = 500) {
  const wait = lastCallAt + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/**
 * GoPlus does not support Robinhood Chain (chain 4663 is explicitly
 * rejected), so this uses ScanHood -- a free, no-key, open-source scanner
 * built specifically for this chain that simulates an actual buy+sell round
 * trip on-chain (real callStatic, not a heuristic) to detect honeypots, plus
 * LP-lock status, contract verification, and deployer reputation.
 *
 * `sellable: true` means the honeypot simulation passed *right now* -- per
 * ScanHood's own docs, that's not a guarantee of future safety or a buy
 * signal, just the best available real-time check on this chain.
 */
export async function getTokenSafety(tokenAddress: string): Promise<TokenSafety> {
  const url = `${config.scanhood.baseUrl}/api/scan?token=${tokenAddress}`;

  try {
    await throttle();
    const data = await fetchJson<ScanHoodResponse>(url, { timeoutMs: 8_000, retries: 1 });

    if (typeof data.verdict !== "string") {
      logger.warn(`ScanHood: unrecognized response shape for ${tokenAddress}: ${JSON.stringify(data).slice(0, 200)}`);
      return {
        score: 0,
        reasons: ["scanhood_unverifiable"],
        isHoneypot: true,
        buyTaxPct: 0,
        sellTaxPct: 0,
        unverifiable: true,
      };
    }

    const verdict = data.verdict.toUpperCase();
    const isHoneypot = data.sellable === false || verdict === "DANGER";
    const reasons: string[] = Array.isArray(data.flags) ? data.flags.map(flagToString) : [];

    let score = verdict === "PASS" ? 90 : verdict === "CAUTION" ? 50 : 0;

    const lpStatus = (data.lp?.status ?? data.lp_status ?? "").toLowerCase();
    const lpLocked = data.lp?.locked ?? (lpStatus ? lpStatus.includes("lock") : null);
    if (lpLocked === false) {
      score -= 15;
      reasons.push("lp_not_locked");
    }

    score = Math.max(0, Math.min(100, score));

    // A CAUTION verdict purely because the sell simulation couldn't run yet
    // (too new / no pool) isn't "verified risky" -- it's "untested," and
    // deserves a retry once the pool has some real activity, not a
    // permanent rejection.
    const couldNotSimulate = reasons.some((r) => /could not simulate a sell/i.test(r));
    const unverifiable = couldNotSimulate && !isHoneypot && verdict !== "DANGER";

    // ScanHood's docs don't expose buy/sell tax as separate fields (unlike
    // GoPlus) -- taxes would show up as CAUTION/DANGER flags instead.
    return { score, reasons, isHoneypot, buyTaxPct: 0, sellTaxPct: 0, unverifiable };
  } catch (err) {
    logger.warn(`ScanHood: request failed for ${tokenAddress}: ${(err as Error).message}`);
    return {
      score: 0,
      reasons: ["scanhood_unreachable"],
      isHoneypot: true,
      buyTaxPct: 0,
      sellTaxPct: 0,
      unverifiable: true,
    };
  }
}
