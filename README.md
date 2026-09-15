# wallet-signal-bot

Finds profitable Ethereum wallets, watches the mempool so you see their trades
*before* they confirm, and screens Dexscreener's "dex paid" (boosted) low-market-cap
tokens for basic scam red flags — then pushes everything to Telegram.

Scope: **Ethereum mainnet** (confirmed with the requester as plain ETH mainnet DEX
activity, not a separate "Robinhood chain").

## How it works

```
┌─────────────────┐     ┌──────────────────────┐     ┌───────────────────┐
│ New pair watcher │────▶│                       │     │                   │
│ (Uniswap V2/V3   │     │                       │     │                   │
│  factory logs)   │     │                       │     │                   │
└─────────────────┘     │     Signal Engine     │────▶│   Telegram bot    │
┌─────────────────┐     │  (in-memory caches +   │     │                   │
│ Mempool watcher  │────▶│   throttled alerts)    │     │                   │
│ (pending swaps)  │     │                       │     └───────────────────┘
└─────────────────┘     └──────────┬────────────┘
                                    │
                      ┌─────────────┴─────────────┐
                      │                            │
              ┌───────▼────────┐         ┌─────────▼─────────┐
              │  Hot tokens     │         │  Smart-money       │
              │  (Dexscreener   │         │  wallet cache       │
              │  boosts + mcap/ │         │  (from DB, refreshed│
              │  liquidity +    │         │  periodically)      │
              │  GoPlus safety) │         └────────────────────┘
              └────────────────┘

Separately, on a cron schedule:
  candidateDiscovery.ts → finds tokens that pumped since first seen,
  pulls their earliest buyers from Etherscan → walletScorer.ts scores
  every candidate wallet's historical realized PnL/win-rate → promotes
  the good ones to `smart_money` tier.
```

### Signal types

- **`smart_money_buy`** — a wallet with a track record of profitable early
  entries is buying something right now (seen in the mempool, pre-confirmation).
- **`new_dex_paid_low_mcap`** — a token just started paying for Dexscreener
  boost/visibility, is under your market-cap ceiling, has enough liquidity,
  and passed a GoPlus honeypot/scam check.
- **`early_mempool_buy`** — real-time buy pressure on a token already on the
  hot list above.
- **`composite`** — both at once (smart wallet buying a hot low-cap token) —
  highest-confidence signal.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Where to get it | Notes |
|---|---|---|
| `ALCHEMY_API_KEY` | [alchemy.com](https://www.alchemy.com/) free tier | Needed for the WS mempool subscription (`alchemy_pendingTransactions`) and live factory-log subscriptions. Free tier is enough to start. |
| `ETHERSCAN_API_KEY` | [etherscan.io/apis](https://etherscan.io/apis) free tier | Used for wallet trade-history based profitability scoring. Rate-limited to ~5 req/sec on free tier; the client already throttles to stay under that. |
| `TELEGRAM_BOT_TOKEN` | Message [@BotFather](https://t.me/BotFather), `/newbot` | |
| `TELEGRAM_CHAT_ID` | Message your new bot once, then hit `https://api.telegram.org/bot<token>/getUpdates` and read `message.chat.id` | Can be your personal chat or a channel/group the bot is in. |

Then:

```bash
npm run build
npm start
```

`npm run dev` runs it directly with `ts-node` (no build step) for iteration.

## One-off scripts

- `npm run discover-wallets` — scans recently-seen tokens for pumps and pulls
  their earliest buyers into the `wallets` table as `candidate` tier.
- `npm run score-wallets` — scores every `candidate` wallet from on-chain
  history and promotes the profitable ones to `smart_money`.

The main process (`npm start`) also runs both of these on a cron schedule
(every 6 hours, offset by 30 min) so the smart-money list grows on its own.
Run them manually first if you want signals sooner — a fresh DB has no
smart-money wallets yet, so `smart_money_buy`/`composite` signals won't fire
until at least one scoring pass has run.

## Design notes / honest limitations

- **Wallet PnL scoring is heuristic**, not exact. It decodes each wallet's own
  Uniswap V2/V3 router calls from Etherscan history, matches buy-ETH-spent vs
  sell-ETH-received *per token* (not per-lot/FIFO), and scores on win-rate +
  realized PnL + trade count. It captures the common "ape in, dump the bag"
  pattern well; it will be less precise for wallets that scale in/out of a
  position over time. If you get a paid Dune, Nansen, or Bitquery API key,
  swap `src/wallets/walletScorer.ts`'s data source for exact per-lot PnL —
  the rest of the pipeline (DB schema, tiering, signal engine) doesn't need
  to change.
- **Mempool decoding covers Uniswap V2 Router02 and V3 SwapRouter/SwapRouter02**
  only. It does *not* decode Uniswap's Universal Router (packed command
  encoding) or other DEXes (Sushiswap, 1inch, etc.) — those pending swaps are
  simply skipped rather than mis-decoded. Universal Router now carries a
  large and growing share of Uniswap volume, so extending
  `src/decode/swapDecoder.ts` to cover it is the highest-value next step if
  you're missing signals.
- **"Dex paid" detection** uses Dexscreener's public (undocumented, no API
  key) token-boosts endpoints. There's no guarantee Dexscreener keeps this
  endpoint stable — if it starts 404ing, check
  `src/providers/dexscreener.ts` first.
- **Safety screening (GoPlus)** filters out obvious honeypots/backdoors/high
  taxes, but this is not a rug-pull guarantee. Low-cap, freshly-boosted
  tokens are inherently high risk; treat every signal as a lead to research
  further, not a trade instruction.
- **New-pair discovery only tracks WETH-paired pools.** Pairs quoted in other
  tokens (USDC, etc.) are currently skipped since pricing them needs an extra
  hop — `candidateTokenFromPair` in `src/chain/newPairWatcher.ts` is where
  that logic lives if you want to extend it.

## Project layout

```
src/
  config.ts              env + thresholds
  types.ts                shared types
  db/                     SQLite schema + repositories
  providers/              Dexscreener, GoPlus, Etherscan clients
  chain/                  viem client, new-pair watcher, mempool watcher
  decode/                 Uniswap V2/V3 calldata ABIs + swap decoder
  wallets/                candidate discovery + profitability scoring
  signals/                hot-token screening + the signal engine
  telegram/               alert delivery
  scripts/                one-off discovery/scoring runners
  index.ts                main process: wires everything + cron
```
