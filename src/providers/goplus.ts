import { fetchJson } from "../utils/http";

const BASE = "https://api.gopluslabs.io/api/v1";
const ETH_CHAIN_ID = "1";

interface GoPlusTokenSecurityData {
  is_honeypot?: string;
  is_open_source?: string;
  is_proxy?: string;
  is_mintable?: string;
  can_take_back_ownership?: string;
  owner_change_balance?: string;
  hidden_owner?: string;
  selfdestruct?: string;
  external_call?: string;
  buy_tax?: string;
  sell_tax?: string;
  is_blacklisted?: string;
  is_whitelisted?: string;
  trust_list?: string;
  holder_count?: string;
  lp_holder_count?: string;
  is_true_token?: string;
  is_airdrop_scam?: string;
}

interface GoPlusResponse {
  code: number;
  message: string;
  result: Record<string, GoPlusTokenSecurityData>;
}

export interface TokenSafety {
  score: number; // 0-100, higher is safer
  reasons: string[];
  isHoneypot: boolean;
  buyTaxPct: number;
  sellTaxPct: number;
}

const TRUE = "1";

/**
 * Heuristic 0-100 safety score from GoPlus token-security flags. This is not
 * a guarantee against scams/rugs -- it filters out the most common obvious
 * traps (honeypots, hidden mint/blacklist backdoors, extreme taxes) before a
 * low-cap "dex paid" token is ever surfaced as a signal.
 */
export async function getTokenSafety(tokenAddress: string): Promise<TokenSafety> {
  const url = `${BASE}/token_security/${ETH_CHAIN_ID}?contract_addresses=${tokenAddress}`;
  const data = await fetchJson<GoPlusResponse>(url);
  const info = data.result?.[tokenAddress.toLowerCase()];

  if (!info) {
    return { score: 0, reasons: ["no_goplus_data"], isHoneypot: true, buyTaxPct: 0, sellTaxPct: 0 };
  }

  let score = 100;
  const reasons: string[] = [];
  const isHoneypot = info.is_honeypot === TRUE;

  if (isHoneypot) {
    score -= 100;
    reasons.push("honeypot");
  }
  if (info.is_open_source !== TRUE) {
    score -= 20;
    reasons.push("not_open_source");
  }
  if (info.hidden_owner === TRUE) {
    score -= 25;
    reasons.push("hidden_owner");
  }
  if (info.can_take_back_ownership === TRUE) {
    score -= 25;
    reasons.push("can_reclaim_ownership");
  }
  if (info.owner_change_balance === TRUE) {
    score -= 25;
    reasons.push("owner_can_change_balances");
  }
  if (info.selfdestruct === TRUE) {
    score -= 20;
    reasons.push("selfdestructible");
  }
  if (info.is_blacklisted === TRUE) {
    score -= 15;
    reasons.push("blacklist_function");
  }
  if (info.is_airdrop_scam === TRUE) {
    score -= 30;
    reasons.push("flagged_airdrop_scam");
  }

  const buyTaxPct = Number(info.buy_tax ?? 0) * 100;
  const sellTaxPct = Number(info.sell_tax ?? 0) * 100;
  if (buyTaxPct > 10) {
    score -= 15;
    reasons.push(`high_buy_tax_${buyTaxPct.toFixed(0)}pct`);
  }
  if (sellTaxPct > 10) {
    score -= 20;
    reasons.push(`high_sell_tax_${sellTaxPct.toFixed(0)}pct`);
  }

  const lpHolders = Number(info.lp_holder_count ?? 0);
  if (lpHolders > 0 && lpHolders < 3) {
    score -= 10;
    reasons.push("very_few_lp_holders");
  }

  score = Math.max(0, Math.min(100, score));
  return { score, reasons, isHoneypot, buyTaxPct, sellTaxPct };
}
