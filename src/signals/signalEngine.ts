import { signalsRepo, tokensRepo, walletsRepo } from "../db";
import { config } from "../config";
import { startMempoolWatcher } from "../chain/mempoolWatcher";
import { candidateTokenFromPair, startNewPairWatcher, type NewPairEvent } from "../chain/newPairWatcher";
import { getBestPair } from "../providers/dexscreener";
import { getTokenSafety } from "../providers/goplus";
import { refreshHotTokens } from "./hotTokens";
import type { SignalRecord, TokenRecord } from "../types";
import { logger } from "../utils/logger";
import { Throttle } from "../utils/throttle";

const SMART_MONEY_REFRESH_MS = 5 * 60 * 1000;
const HOT_TOKENS_REFRESH_MS = 3 * 60 * 1000;
const SIGNAL_THROTTLE_MS = 15 * 60 * 1000;

function short(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function walletTrackRecord(address: string): string {
  const w = walletsRepo.get(address);
  if (!w) return "";
  const pnl = w.realizedPnlUsd != null ? `$${w.realizedPnlUsd.toFixed(0)}` : `${w.realizedPnlEth.toFixed(2)} ETH`;
  return ` (score ${w.score.toFixed(0)}, realized PnL ${pnl}, ${w.tradesCount} trades, via ${w.dataSource})`;
}

export function startSignalEngine(onSignal: (s: SignalRecord) => void): () => void {
  let smartMoney = new Set<string>();
  let hotTokens = new Map<string, TokenRecord>();
  const throttle = new Throttle();

  async function refreshSmartMoney() {
    try {
      const wallets = walletsRepo.smartMoney(config.thresholds.minWalletScore);
      smartMoney = new Set(wallets.map((w) => w.address));
      logger.info(`Smart-money cache refreshed: ${smartMoney.size} wallet(s).`);
    } catch (err) {
      logger.warn("Failed to refresh smart-money cache:", (err as Error).message);
    }
  }

  async function refreshHot() {
    try {
      hotTokens = await refreshHotTokens();
    } catch (err) {
      logger.warn("Failed to refresh hot-token cache:", (err as Error).message);
    }
  }

  function emit(partial: Omit<SignalRecord, "id" | "createdAt" | "sentToTelegram">) {
    const record: SignalRecord = { ...partial, createdAt: Date.now(), sentToTelegram: false };
    const id = signalsRepo.insert(record);
    onSignal({ ...record, id });
  }

  const pendingFreshPairChecks = new Set<ReturnType<typeof setTimeout>>();

  /**
   * "GMGN-style" fresh-listing signal: fires once a brand-new pair has real
   * liquidity and passes a basic safety check. Runs on a delay after
   * creation because Dexscreener typically hasn't indexed a pool in the
   * first few seconds -- this is still "early" relative to when a human
   * would notice a new listing, just not the very first block.
   */
  async function checkFreshPair(candidate: string, ev: NewPairEvent) {
    try {
      const pair = await getBestPair(config.chain.name, candidate);
      const marketCapUsd = pair?.marketCap ?? pair?.fdv ?? null;
      const liquidityUsd = pair?.liquidity?.usd ?? null;
      if (!liquidityUsd || liquidityUsd < config.thresholds.minFreshPairLiquidityUsd) return;

      const safety = await getTokenSafety(candidate);
      if (safety.isHoneypot || safety.score < config.thresholds.minSafetyScore) {
        logger.info(`Fresh pair: skipping ${candidate} (safety score ${safety.score}: ${safety.reasons.join(",")})`);
        return;
      }

      const existing = tokensRepo.get(candidate);
      tokensRepo.upsert({
        address: candidate,
        symbol: pair?.baseToken?.symbol ?? existing?.symbol ?? null,
        name: pair?.baseToken?.name ?? existing?.name ?? null,
        firstSeenAt: existing?.firstSeenAt ?? Date.now(),
        initialMarketCapUsd: existing?.initialMarketCapUsd ?? marketCapUsd,
        marketCapUsd,
        liquidityUsd,
        isDexPaid: existing?.isDexPaid ?? false,
        safetyScore: safety.score,
        lastCheckedAt: Date.now(),
      });

      const label = pair?.baseToken?.symbol ?? candidate;
      emit({
        tokenAddress: candidate,
        walletAddress: null,
        signalType: "fresh_pair",
        score: 50,
        message:
          `🆕 Fresh pair: ${label} just got a live market on ${ev.dex === "uniswap_v3" ? "Uniswap V3" : "Uniswap V2"}.\n` +
          `MCap: $${marketCapUsd?.toLocaleString() ?? "?"} | Liquidity: $${liquidityUsd.toLocaleString()} | Safety: ${safety.score}/100\n` +
          `Token: https://dexscreener.com/ethereum/${candidate}\n` +
          `Contract: https://etherscan.io/address/${candidate}`,
      });
    } catch (err) {
      logger.warn(`Fresh pair: failed checking ${candidate}: ${(err as Error).message}`);
    }
  }

  refreshSmartMoney();
  refreshHot();
  const smartMoneyTimer = setInterval(refreshSmartMoney, SMART_MONEY_REFRESH_MS);
  const hotTokensTimer = setInterval(refreshHot, HOT_TOKENS_REFRESH_MS);

  let totalPairEvents = 0;
  let wethPairEvents = 0;
  const heartbeatTimer = setInterval(() => {
    logger.info(
      `New-pair watcher heartbeat: ${totalPairEvents} total pair(s) seen, ${wethPairEvents} WETH-paired, since last heartbeat.`
    );
    totalPairEvents = 0;
    wethPairEvents = 0;
  }, HOT_TOKENS_REFRESH_MS);

  const stopNewPairWatcher = startNewPairWatcher(async (ev) => {
    totalPairEvents++;
    const candidate = candidateTokenFromPair(ev);
    if (!candidate) return;
    wethPairEvents++;
    if (tokensRepo.get(candidate)) return; // already tracked

    let initialMarketCapUsd: number | null = null;
    try {
      const pair = await getBestPair(config.chain.name, candidate);
      initialMarketCapUsd = pair?.marketCap ?? pair?.fdv ?? null;
    } catch {
      // Dexscreener often hasn't indexed a pair seconds after creation -- fine, backfilled later.
    }

    tokensRepo.upsert({
      address: candidate,
      symbol: null,
      name: null,
      firstSeenAt: Date.now(),
      initialMarketCapUsd,
      marketCapUsd: initialMarketCapUsd,
      liquidityUsd: null,
      isDexPaid: false,
      safetyScore: null,
      lastCheckedAt: Date.now(),
    });
    logger.info(`New pair tracked: ${candidate} (${ev.dex}, initial mcap ${initialMarketCapUsd ?? "unknown"}).`);

    const timer = setTimeout(() => {
      pendingFreshPairChecks.delete(timer);
      checkFreshPair(candidate, ev);
    }, config.freshPair.checkDelayMs);
    pendingFreshPairChecks.add(timer);
  });

  let mempoolBuyCount = 0;
  const stopMempoolWatcher = startMempoolWatcher((swap) => {
    if (swap.side !== "buy") return;
    mempoolBuyCount++;
    if (mempoolBuyCount % 50 === 0) {
      logger.info(`Mempool watcher: ${mempoolBuyCount} router buys seen so far (most won't match a signal yet).`);
    }

    const isSmartMoney = smartMoney.has(swap.trader);
    const hotToken = hotTokens.get(swap.tokenAddress);
    if (!isSmartMoney && !hotToken) return;

    const throttleKey = `${swap.tokenAddress}:${swap.trader}`;
    if (!throttle.shouldFire(throttleKey, SIGNAL_THROTTLE_MS)) return;

    const ethPart = swap.ethAmount ? `${swap.ethAmount.toFixed(3)} ETH` : "unknown amount";
    const tokenLabel = hotToken?.symbol ?? swap.tokenAddress;

    if (isSmartMoney && hotToken) {
      emit({
        tokenAddress: swap.tokenAddress,
        walletAddress: swap.trader,
        signalType: "composite",
        score: 95,
        message:
          `🚨 COMPOSITE SIGNAL\n` +
          `Tracked smart-money wallet ${short(swap.trader)}${walletTrackRecord(swap.trader)} is buying ${tokenLabel} (${ethPart}) ` +
          `-- a dex-paid, low-mcap token -- in the mempool right now (tx pending).\n` +
          `Token: https://dexscreener.com/ethereum/${swap.tokenAddress}\n` +
          `Wallet: https://etherscan.io/address/${swap.trader}`,
      });
    } else if (isSmartMoney) {
      emit({
        tokenAddress: swap.tokenAddress,
        walletAddress: swap.trader,
        signalType: "smart_money_buy",
        score: 75,
        message:
          `📈 Smart-money wallet ${short(swap.trader)}${walletTrackRecord(swap.trader)} is buying ${tokenLabel} (${ethPart}) -- pending in mempool.\n` +
          `Token: https://dexscreener.com/ethereum/${swap.tokenAddress}\n` +
          `Wallet: https://etherscan.io/address/${swap.trader}`,
      });
    } else if (hotToken) {
      emit({
        tokenAddress: swap.tokenAddress,
        walletAddress: swap.trader,
        signalType: "early_mempool_buy",
        score: 55,
        message:
          `👀 Buy pressure on dex-paid low-mcap token ${tokenLabel} (${ethPart}) from ${short(swap.trader)} -- pending in mempool.\n` +
          `MCap: $${hotToken.marketCapUsd?.toLocaleString() ?? "?"} | Liquidity: $${hotToken.liquidityUsd?.toLocaleString() ?? "?"}\n` +
          `Token: https://dexscreener.com/ethereum/${swap.tokenAddress}`,
      });
    }
  });

  logger.info("Signal engine started.");

  return () => {
    clearInterval(smartMoneyTimer);
    clearInterval(hotTokensTimer);
    clearInterval(heartbeatTimer);
    for (const timer of pendingFreshPairChecks) clearTimeout(timer);
    pendingFreshPairChecks.clear();
    stopNewPairWatcher();
    stopMempoolWatcher();
  };
}
