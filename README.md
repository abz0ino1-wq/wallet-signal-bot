# wallet-signal-bot

Finds profitable wallets on **Robinhood Chain**, watches confirmed swaps in
real time (early — this chain has ~100ms blocks, so there's barely a mempool
window worth watching separately), and screens Dexscreener's "dex paid"
(boosted) low-market-cap tokens plus every brand-new pair for basic scam red
flags — then pushes everything to Telegram.

Scope: **Robinhood Chain** (chainId `4663`, an Arbitrum Orbit L2, EVM
compatible, launched mainnet July 2026). Originally built against Ethereum
mainnet, then retargeted once it became clear "Robinhood chain" meant this
specific chain (confirmed via GMGN, which tracks it as `chain=robinhood`)
rather than Ethereum accessed through the Robinhood app.

## How it works

```
┌──────────────────┐     ┌──────────────────────┐     ┌───────────────────┐
│ New pair watcher  │────▶│                       │     │                   │
│ (Uniswap V2/V3    │     │                       │     │                   │
│  factory logs)    │     │                       │     │                   │
└───────────────────┘     │     Signal Engine     │────▶│   Telegram bot    │
┌───────────────────┐     │  (in-memory caches +   │     │                   │
│ Swap watcher       │────▶│   throttled alerts)    │     │                   │
│ (confirmed Swap    │     │                       │     └───────────────────┘
│  events, chain-wide)│     └──────────┬────────────┘
└───────────────────┘                 │
                      ┌─────────────┴─────────────┐
                      │                            │
              ┌───────▼────────┐         ┌─────────▼─────────┐
              │  Hot tokens     │         │  Smart-money       │
              │  (Dexscreener   │         │  wallet cache       │
              │  boosts + mcap/ │         │  (from DB, refreshed│
              │  liquidity +    │         │  periodically)      │
              │  ScanHood safety)│         └────────────────────┘
              └────────────────┘

Separately, on a cron schedule:
  candidateDiscovery.ts → finds tokens that pumped since first seen,
  pulls their earliest buyers from Blockscout → walletScorer.ts scores
  every candidate wallet's historical realized PnL/win-rate → promotes
  the good ones to `smart_money` tier.
```

### Signal types

- **`smart_money_buy`** — a wallet with a track record of profitable early
  entries just bought something (a confirmed on-chain swap).
- **`new_dex_paid_low_mcap`** — a token just started paying for Dexscreener
  boost/visibility, is under your market-cap ceiling, has enough liquidity,
  and passed a ScanHood honeypot/scam check.
- **`hot_token_buy`** — real-time buy pressure on a token already on the
  hot list above.
- **`fresh_pair`** — a brand-new Uniswap pool just went live (checked ~15s
  after creation, once it has real liquidity and passes the ScanHood safety
  check). This is the "just migrated / just listed" signal — closer to what
  GMGN's migration feed surfaces than the boost-based
  `new_dex_paid_low_mcap`, which depends on a token actually showing up in
  Dexscreener's boosted-token feed.
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
| `ALCHEMY_API_KEY` | [alchemy.com](https://www.alchemy.com/) — create an app for **Robinhood Chain** | Needed for live factory-log and Swap-event subscriptions. Check the exact WS/HTTP URL your Alchemy dashboard shows for the Robinhood Chain app -- if it differs from the guessed `robinhood-mainnet.g.alchemy.com` pattern in `src/config.ts`, set `ALCHEMY_WS_URL`/`ALCHEMY_HTTP_URL` explicitly. |
| `BLOCKSCOUT_API_URL` | Optional, defaults to `https://robinhoodchain.blockscout.com/api` | Robinhood Chain's block explorer, Etherscan-API-compatible, free and keyless. |
| `SCANHOOD_API_URL` | Optional, defaults to `https://api.scanhood.xyz` | Honeypot/rug check -- see the caveat below, this one needs verifying against the real API. |
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
until at least one scoring pass has run, and discovery itself needs the DB
to already have some tokens in it (built up by the new-pair watcher while
running), so expect the smart-money list to take real wall-clock days to
grow meaningfully.

## Design notes / honest limitations

This chain launched ~2 months before this was built, so several pieces here
are necessarily best-effort rather than fully verified — flagged explicitly
rather than papered over:

- **`ALCHEMY_API_KEY`'s URL pattern is a guess.** Alchemy officially
  supports Robinhood Chain, but this environment couldn't independently
  confirm the exact subdomain, so `src/config.ts` guesses
  `robinhood-mainnet.g.alchemy.com` following Alchemy's naming convention
  for other chains. Check your Alchemy dashboard when you create the app;
  override via `ALCHEMY_WS_URL`/`ALCHEMY_HTTP_URL` if it's different.
- **ScanHood's API contract (`src/providers/scanhood.ts`) is a best-effort
  guess**, not verified against a live response — this dev environment
  couldn't reach scanhood.xyz to confirm the endpoint path or response
  field names. It fails *safe*: any error or unrecognized response treats
  the token as unsafe (skips the alert) rather than the other way around,
  so a wrong guess here means missing `fresh_pair`/`new_dex_paid_low_mcap`
  alerts, not unsafe tokens slipping through. If you see
  `scanhood_unreachable` or `scanhood_unverifiable` in the logs
  consistently, that's this contract being wrong — check scanhood.xyz's
  actual docs (reachable from your VPS, unlike this dev environment) and
  fix the URL/field names.
- **The wallet-scoring heuristic decodes V2 Router02 and V3 SwapRouter02
  calldata only.** It does *not* decode Universal Router calldata (packed
  command encoding) -- which is the *preferred* entrypoint on this chain
  per Uniswap's own announcement. This means historical wallet scoring
  undercounts trades and is a lower bound on real PnL, not exact. The live
  signal path doesn't have this gap: `src/chain/swapWatcher.ts` watches
  confirmed Swap events directly rather than decoding router calldata, so
  it sees every swap regardless of entrypoint.
- **The swap watcher approximates "trader" as the Swap event's recipient**
  (`to`/`recipient` field) rather than the transaction's `from`, to avoid an
  extra RPC call per swap. Correct for the common case (a wallet swapping
  directly); can misattribute swaps routed through an intermediary contract
  that sets a different recipient.
- **"Dex paid" detection** uses Dexscreener's public (undocumented, no API
  key) token-boosts endpoints, filtered to `chainId === "robinhood"` --
  also unverified live from this environment. If `Hot tokens: fetched X...
  (0 on robinhood)` shows up consistently, check that chain slug in
  `src/signals/hotTokens.ts` and `src/config.ts`'s `chain.name`.
- **Safety screening is not a rug-pull guarantee** regardless of provider.
  Low-cap, freshly-listed tokens are inherently high risk; treat every
  signal as a lead to research further, not a trade instruction.
- **New-pair discovery only tracks WETH-paired pools.** Pairs quoted in
  other tokens are currently skipped since pricing them needs an extra hop
  — `candidateTokenFromPair` in `src/chain/newPairWatcher.ts` is where that
  logic lives if you want to extend it.
- **No paid wallet-PnL indexer (Moralis/Nansen/etc.) is wired up.** This
  chain is too new for most of them to have added support yet; the local
  heuristic scorer is the only option right now.

## Project layout

```
src/
  config.ts              env + thresholds + chain config
  types.ts                shared types
  db/                     SQLite schema + repositories
  providers/              Dexscreener, ScanHood, Blockscout clients
  chain/                  viem client, WETH resolution, new-pair watcher,
                          swap watcher, pool registry
  decode/                 Uniswap V2/V3 calldata ABIs + swap decoder
  wallets/                candidate discovery + profitability scoring
  signals/                hot-token screening + the signal engine
  telegram/               alert delivery
  scripts/                one-off discovery/scoring runners
  index.ts                main process: wires everything + cron
```
