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
- **`fresh_pair`** — a brand-new Uniswap pool just went live (checked ~15s
  after creation, once it has real liquidity and passes a GoPlus safety
  check). This is the "just migrated / just listed" signal — closer to what
  tools like GMGN surface than the boost-based `new_dex_paid_low_mcap`,
  which depends on Dexscreener's boosted-token feed actually having
  Ethereum-chain tokens in it (often it doesn't -- that activity skews
  heavily toward Solana/Base).
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
| `ETHERSCAN_API_KEY` | [etherscan.io/apis](https://etherscan.io/apis) free tier | Used for the fallback wallet-scoring heuristic and as the earliest-buyers discovery method. Rate-limited to ~5 req/sec on free tier; the client already throttles to stay under that. |
| `MORALIS_API_KEY` | [moralis.io](https://moralis.io) free tier | **Recommended.** Unlocks server-computed, USD-denominated wallet PnL (`/wallets/{address}/profitability/summary`) and per-token top-profitable-wallet lookups instead of the local heuristic. See "Wallet scoring: Moralis vs. heuristic" below. |
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

## Wallet scoring: Moralis vs. heuristic

`src/wallets/walletScorer.ts` tries Moralis first (`getWalletProfitabilitySummary`)
and only falls back to the local heuristic if `MORALIS_API_KEY` is unset, the
call fails, or Moralis has no trade data for that wallet. Every scored wallet
records which path produced it (`wallets.data_source` — `"moralis"` or
`"heuristic"`), and Telegram alerts show it (`via moralis` / `via heuristic`)
so you can see which signals are backed by the stronger data.

Wallet *discovery* (finding candidates in the first place) works the same
way: `src/wallets/candidateDiscovery.ts` first tries Moralis'
top-profitable-wallets-per-token endpoint for a pumped token — which directly
returns wallets that were *actually profitable* on it — and only falls back
to "pull the token's earliest buyers from Etherscan" (a weaker proxy: early
≠ profitable) when Moralis is unset or returns nothing for that token.

## Design notes / honest limitations

- **The Moralis per-token top-profitable-wallets endpoint path
  (`/erc20/{address}/top-profitable-wallets`) is a best-effort implementation.**
  Moralis' wallet-PnL-summary endpoint and fields are well-documented and
  confirmed; the per-token endpoint's exact path/response shape was
  reconstructed from Moralis' documented naming conventions and could not be
  independently verified against a live response in this environment (network
  egress here is restricted to package registries, not arbitrary APIs). It's
  wrapped defensively — a failed/malformed response returns `null` and
  `candidateDiscovery.ts` transparently falls back to the Etherscan method —
  so a wrong path degrades gracefully rather than breaking anything. If it
  404s for you, check `src/providers/moralis.ts` against
  https://docs.moralis.com/web3-data-api/evm/reference/get-top-profitable-wallet-per-token
  and adjust the URL.
- **The heuristic fallback scorer is not exact.** It decodes each wallet's own
  Uniswap V2/V3 router calls from Etherscan history, matches buy-ETH-spent vs
  sell-ETH-received *per token* (not per-lot/FIFO), and scores on win-rate +
  realized PnL + trade count. It captures the common "ape in, dump the bag"
  pattern well; it will be less precise for wallets that scale in/out of a
  position over time. This only runs when Moralis isn't configured/available.
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
  providers/              Dexscreener, GoPlus, Etherscan, Moralis clients
  chain/                  viem client, new-pair watcher, mempool watcher
  decode/                 Uniswap V2/V3 calldata ABIs + swap decoder
  wallets/                candidate discovery + profitability scoring
  signals/                hot-token screening + the signal engine
  telegram/               alert delivery
  scripts/                one-off discovery/scoring runners
  index.ts                main process: wires everything + cron
```
