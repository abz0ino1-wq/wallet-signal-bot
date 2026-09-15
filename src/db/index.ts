import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "../config";
import type { SignalRecord, TokenRecord, WalletRecord, WalletTier, WalletTrade } from "../types";

const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(config.db.path);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  first_seen_at INTEGER NOT NULL,
  initial_market_cap_usd REAL,
  market_cap_usd REAL,
  liquidity_usd REAL,
  is_dex_paid INTEGER NOT NULL DEFAULT 0,
  safety_score REAL,
  last_checked_at INTEGER
);

CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  score REAL NOT NULL DEFAULT 0,
  win_rate REAL NOT NULL DEFAULT 0,
  realized_pnl_eth REAL NOT NULL DEFAULT 0,
  realized_pnl_usd REAL,
  trades_count INTEGER NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'candidate',
  data_source TEXT NOT NULL DEFAULT 'heuristic',
  last_scored_at INTEGER
);

CREATE TABLE IF NOT EXISTS wallet_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  side TEXT NOT NULL,
  amount_eth REAL NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallet_trades_wallet ON wallet_trades(wallet_address);
CREATE INDEX IF NOT EXISTS idx_wallet_trades_token ON wallet_trades(token_address);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  wallet_address TEXT,
  signal_type TEXT NOT NULL,
  score REAL NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_to_telegram INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_signals_token ON signals(token_address);
`);

function rowToToken(row: any): TokenRecord {
  return {
    address: row.address,
    symbol: row.symbol,
    name: row.name,
    firstSeenAt: row.first_seen_at,
    initialMarketCapUsd: row.initial_market_cap_usd,
    marketCapUsd: row.market_cap_usd,
    liquidityUsd: row.liquidity_usd,
    isDexPaid: !!row.is_dex_paid,
    safetyScore: row.safety_score,
    lastCheckedAt: row.last_checked_at,
  };
}

function rowToWallet(row: any): WalletRecord {
  return {
    address: row.address,
    score: row.score,
    winRate: row.win_rate,
    realizedPnlEth: row.realized_pnl_eth,
    realizedPnlUsd: row.realized_pnl_usd,
    tradesCount: row.trades_count,
    tier: row.tier,
    dataSource: row.data_source,
    lastScoredAt: row.last_scored_at,
  };
}

export const tokensRepo = {
  upsert(token: TokenRecord) {
    db.prepare(
      `INSERT INTO tokens (address, symbol, name, first_seen_at, initial_market_cap_usd, market_cap_usd, liquidity_usd, is_dex_paid, safety_score, last_checked_at)
       VALUES (@address, @symbol, @name, @firstSeenAt, @initialMarketCapUsd, @marketCapUsd, @liquidityUsd, @isDexPaid, @safetyScore, @lastCheckedAt)
       ON CONFLICT(address) DO UPDATE SET
         symbol = excluded.symbol,
         name = excluded.name,
         market_cap_usd = excluded.market_cap_usd,
         liquidity_usd = excluded.liquidity_usd,
         is_dex_paid = excluded.is_dex_paid,
         safety_score = excluded.safety_score,
         last_checked_at = excluded.last_checked_at`
    ).run({
      address: token.address.toLowerCase(),
      symbol: token.symbol,
      name: token.name,
      firstSeenAt: token.firstSeenAt,
      initialMarketCapUsd: token.initialMarketCapUsd,
      marketCapUsd: token.marketCapUsd,
      liquidityUsd: token.liquidityUsd,
      isDexPaid: token.isDexPaid ? 1 : 0,
      safetyScore: token.safetyScore,
      lastCheckedAt: token.lastCheckedAt,
    });
  },
  get(address: string): TokenRecord | undefined {
    const row = db.prepare(`SELECT * FROM tokens WHERE address = ?`).get(address.toLowerCase());
    return row ? rowToToken(row) : undefined;
  },
  all(): TokenRecord[] {
    return (db.prepare(`SELECT * FROM tokens`).all() as any[]).map(rowToToken);
  },
  recentlyDiscovered(sinceMs: number): TokenRecord[] {
    return (
      db.prepare(`SELECT * FROM tokens WHERE first_seen_at >= ? ORDER BY first_seen_at DESC`).all(sinceMs) as any[]
    ).map(rowToToken);
  },
};

export const walletsRepo = {
  upsert(wallet: WalletRecord) {
    db.prepare(
      `INSERT INTO wallets (address, score, win_rate, realized_pnl_eth, realized_pnl_usd, trades_count, tier, data_source, last_scored_at)
       VALUES (@address, @score, @winRate, @realizedPnlEth, @realizedPnlUsd, @tradesCount, @tier, @dataSource, @lastScoredAt)
       ON CONFLICT(address) DO UPDATE SET
         score = excluded.score,
         win_rate = excluded.win_rate,
         realized_pnl_eth = excluded.realized_pnl_eth,
         realized_pnl_usd = excluded.realized_pnl_usd,
         trades_count = excluded.trades_count,
         tier = excluded.tier,
         data_source = excluded.data_source,
         last_scored_at = excluded.last_scored_at`
    ).run({
      address: wallet.address.toLowerCase(),
      score: wallet.score,
      winRate: wallet.winRate,
      realizedPnlEth: wallet.realizedPnlEth,
      realizedPnlUsd: wallet.realizedPnlUsd,
      tradesCount: wallet.tradesCount,
      tier: wallet.tier,
      dataSource: wallet.dataSource,
      lastScoredAt: wallet.lastScoredAt,
    });
  },
  get(address: string): WalletRecord | undefined {
    const row = db.prepare(`SELECT * FROM wallets WHERE address = ?`).get(address.toLowerCase());
    return row ? rowToWallet(row) : undefined;
  },
  byTier(tier: WalletTier): WalletRecord[] {
    return (db.prepare(`SELECT * FROM wallets WHERE tier = ?`).all(tier) as any[]).map(rowToWallet);
  },
  smartMoney(minScore: number): WalletRecord[] {
    return (
      db
        .prepare(`SELECT * FROM wallets WHERE tier = 'smart_money' AND score >= ? ORDER BY score DESC`)
        .all(minScore) as any[]
    ).map(rowToWallet);
  },
  all(): WalletRecord[] {
    return (db.prepare(`SELECT * FROM wallets`).all() as any[]).map(rowToWallet);
  },
};

export const walletTradesRepo = {
  insert(trade: WalletTrade) {
    try {
      db.prepare(
        `INSERT INTO wallet_trades (wallet_address, token_address, side, amount_eth, tx_hash, block_number, timestamp)
         VALUES (@walletAddress, @tokenAddress, @side, @amountEth, @txHash, @blockNumber, @timestamp)`
      ).run({
        walletAddress: trade.walletAddress.toLowerCase(),
        tokenAddress: trade.tokenAddress.toLowerCase(),
        side: trade.side,
        amountEth: trade.amountEth,
        txHash: trade.txHash,
        blockNumber: trade.blockNumber,
        timestamp: trade.timestamp,
      });
    } catch (err: any) {
      // Unique constraint on tx_hash -- ignore duplicates from re-processing.
      if (!String(err?.message).includes("UNIQUE")) throw err;
    }
  },
  forWallet(address: string): WalletTrade[] {
    return db
      .prepare(`SELECT * FROM wallet_trades WHERE wallet_address = ? ORDER BY timestamp ASC`)
      .all(address.toLowerCase()) as any[];
  },
  forToken(address: string): WalletTrade[] {
    return db
      .prepare(`SELECT * FROM wallet_trades WHERE token_address = ? ORDER BY timestamp ASC`)
      .all(address.toLowerCase()) as any[];
  },
};

export const signalsRepo = {
  insert(signal: SignalRecord): number {
    const info = db
      .prepare(
        `INSERT INTO signals (token_address, wallet_address, signal_type, score, message, created_at, sent_to_telegram)
         VALUES (@tokenAddress, @walletAddress, @signalType, @score, @message, @createdAt, @sentToTelegram)`
      )
      .run({
        tokenAddress: signal.tokenAddress.toLowerCase(),
        walletAddress: signal.walletAddress?.toLowerCase() ?? null,
        signalType: signal.signalType,
        score: signal.score,
        message: signal.message,
        createdAt: signal.createdAt,
        sentToTelegram: signal.sentToTelegram ? 1 : 0,
      });
    return Number(info.lastInsertRowid);
  },
  markSent(id: number) {
    db.prepare(`UPDATE signals SET sent_to_telegram = 1 WHERE id = ?`).run(id);
  },
  recentForToken(address: string, sinceMs: number): SignalRecord[] {
    return db
      .prepare(`SELECT * FROM signals WHERE token_address = ? AND created_at >= ?`)
      .all(address.toLowerCase(), sinceMs) as any[];
  },
};
