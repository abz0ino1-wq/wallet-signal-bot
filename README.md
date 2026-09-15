# wallet-signal-bot

Finds profitable wallets on **Robinhood Chain**, watches confirmed swaps in
real time across Uniswap V2, V3, *and V4* (early — this chain has ~100ms
blocks, so there's barely a mempool window worth watching separately), and
screens Dexscreener's "dex paid" (boosted) low-market-cap tokens plus every
brand-new pair for basic scam red flags — then pushes everything to
Telegram.

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
│  factory logs +   │     │                       │     │                   │
│  V4 PoolManager)   │     │     Signal Engine     │────▶│   Telegram bot    │
└───────────────────┘     │  (in-memory caches +   │     │                   │
┌───────────────────┐     │   throttled alerts)    │     │                   │
│ Swap watcher       │────▶│                       │     └───────────────────┘
│ (confirmed Swap    │     └──────────┬────────────┘
│  events, V2+V3+V4)  │                │
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
  boost/visibility, sits inside your market-cap band (`MIN_MARKET_CAP_USD`–
  `MAX_MARKET_CAP_USD`, default $3k–$10k), has enough liquidity and 24h
  volume (`MIN_VOLUME_USD`), is still under `MAX_TOKEN_AGE_HOURS` (default
  6h — a token can launch, sit for a day, then start paying for a boost;
  this keeps the signal about fresh tokens, not just currently-boosted
  ones), and passed a ScanHood honeypot/scam check.
- **`hot_token_buy`** — real-time buy pressure on a token already on the
  hot list above.
- **`fresh_pair`** — a brand-new Uniswap pool just went live (first checked
  ~5s after creation, once it has real liquidity, is still under
  `MAX_FRESH_PAIR_MARKET_CAP_USD` (default $30k — some tokens on this chain
  pump 10-50x within seconds, so this ceiling exists specifically to skip
  ones that already ran before we could report them), and passes the
  ScanHood safety check). This is the "just migrated / just listed" signal
  — closer to what GMGN's migration feed surfaces than the boost-based
  `new_dex_paid_low_mcap`, which depends on a token actually showing up in
  Dexscreener's boosted-token feed.
- **`composite`** — both at once (smart wallet buying a hot low-cap token) —
  highest-confidence signal.

### Safety filtering

Every signal type runs through ScanHood before it can fire:

- A real **DANGER**/honeypot verdict, or a low safety score, blocks the
  token outright.
- An **unlocked LP** is treated as an automatic fail regardless of anything
  else ScanHood reports — it means the deployer can pull liquidity at will,
  the single biggest rug-pull vector on this chain.
- ScanHood sometimes can't run its sell simulation at all (common on V4
  pools, not just brand-new ones). That alone doesn't block — it gets
  retried, and if still unresolved the token is let through flagged
  **⚠️ UNVERIFIED** rather than hidden forever. But that only applies when
  the sell-simulation gap is the *only* issue — if it's bundled with a real
  risk flag (like the unlocked-LP case above), that flag still blocks. An
  unverifiable result never overrides an actual finding.

`MIN_FRESH_PAIR_LIQUIDITY_USD` (default $5k) is kept above a trivially
fakeable floor — a pool seeded with only ~$2k in liquidity is cheap enough
that dead, going-nowhere launches routinely cleared it too.

### Call tracking (follow-up alerts)

Every time a signal fires for a token, its market cap at that moment is
recorded as "the call" (first alert only — later signals on the same token
don't reset it). A background pass (`CALL_CHECK_INTERVAL_MS`, default every
3 minutes) then re-checks each tracked token's current market cap and tracks
the peak seen since the call. The first time that peak crosses a new
multiple (2x, 3x, 5x, 10x, 20x, 50x, 100x, 200x, 500x, 1000x), it sends a
follow-up message:

```
🔥 $ACORN hit 5X
called $91k → $453k
peak since the call · dyor
```

A token stops being tracked after `CALL_TRACK_WINDOW_HOURS` (default 72h)
with no further checks, so long-dead calls don't waste API calls forever.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Where to get it | Notes |
|---|---|---|
| `ALCHEMY_API_KEY` | [alchemy.com](https://www.alchemy.com/) — create an app for **Robinhood Chain** | Needed for live factory-log and Swap-event subscriptions. The `robinhood-mainnet.g.alchemy.com` URL pattern in `src/config.ts` is confirmed working. |
| `BLOCKSCOUT_API_URL` | Optional, defaults to `https://robinhoodchain.blockscout.com/api` | Robinhood Chain's block explorer, Etherscan-API-compatible, free and keyless. |
| `SCANHOOD_API_URL` | Optional, defaults to `https://scanhood.xyz` | Honeypot/rug check, confirmed against ScanHood's own agent-facing docs at `scanhood.xyz/llms.txt`. |
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

This chain launched ~2 months before this was built. The RPC endpoint and
ScanHood's API contract were both confirmed working live (the former by
successful WETH resolution + a live Swap-event stream at startup; the
latter against `scanhood.xyz/llms.txt`, ScanHood's own agent-facing API
docs) -- but a few things are still worth knowing:

- **ScanHood doesn't expose separate buy/sell tax fields** (unlike GoPlus)
  -- its `getTokenSafety()` always returns `buyTaxPct`/`sellTaxPct` as `0`;
  taxes show up as CAUTION/DANGER flags in its `verdict` instead. The
  `lp.status`/`lp_locked` field parsing in `src/providers/scanhood.ts` is
  based on the docs' prose description, not a literal example response --
  if `lp_not_locked` never shows up in reasons even for tokens you'd expect
  it on, that field name may need adjusting.
- **Two different failure modes, two different defaults.** A network
  error or unrecognized response shape (`scanhood_unreachable`/
  `scanhood_unverifiable` reasons) still fails *closed* -- treated as
  unsafe, alert skipped. If you see those *consistently* (not just an
  occasional timeout), something about the contract has changed --
  re-check `scanhood.xyz/llms.txt`. But a CAUTION verdict where the *only*
  issue is "could not simulate a sell" (ScanHood structurally failing to
  find/test some V4 pools -- confirmed on a token 44 minutes old with
  heavy volume, so it's not just a timing thing) fails *open* after 3
  retries: the alert fires anyway with an explicit "⚠️ UNVERIFIED" label
  rather than permanently suppressing a real token because of a gap in
  ScanHood's own V4 coverage. An actual DANGER/honeypot verdict, or a low
  score for any other reason, still blocks either way.
- **The wallet-scoring heuristic decodes V2 Router02 and V3 SwapRouter02
  calldata only.** It does *not* decode Universal Router calldata (packed
  command encoding) -- which is the *preferred* entrypoint on this chain
  per Uniswap's own announcement. This means historical wallet scoring
  undercounts trades and is a lower bound on real PnL, not exact. The live
  signal path doesn't have this gap: `src/chain/swapWatcher.ts` watches
  confirmed Swap events directly rather than decoding router calldata, so
  it sees every swap regardless of entrypoint.
- **The swap watcher approximates "trader" as the Swap event's own party
  field** (`to` for V2, `recipient` for V3, `sender` for V4) rather than the
  transaction's `from`, to avoid an extra RPC call per swap. Correct for the
  common case (a wallet swapping directly); can misattribute swaps routed
  through an intermediary contract that sets a different party -- **this is
  notably weaker for V4**, since V4 funnels almost every retail swap through
  Universal Router, so `sender` is usually the router's own address, not
  the wallet controlling it. `hot_token_buy`/`new_dex_paid_low_mcap` signals
  still work fine (they don't need to know exactly who), but
  `smart_money_buy`/`composite` detection is unreliable for V4 swaps until
  this is upgraded to resolve the real trader (e.g. via `getTransaction`).
- **"Dex paid" detection** uses Dexscreener's public (undocumented, no API
  key) token-boosts endpoints, filtered to `chainId === "robinhood"` --
  also unverified live from this environment. If `Hot tokens: fetched X...
  (0 on robinhood)` shows up consistently, check that chain slug in
  `src/signals/hotTokens.ts` and `src/config.ts`'s `chain.name`.
- **Safety screening is not a rug-pull guarantee** regardless of provider.
  Low-cap, freshly-listed tokens are inherently high risk; treat every
  signal as a lead to research further, not a trade instruction.
- **New-pair discovery tracks WETH- and native-ETH-paired pools only.**
  V4 pools are commonly paired directly against native ETH (the zero
  address) rather than wrapped WETH -- `isWethOrNative()` in
  `src/chain/weth.ts` handles both. Pools quoted in a different currency
  entirely (this chain has a stablecoin, USDG, that some tokens pair
  against as a *secondary* pool alongside their main ETH-paired one) are
  still skipped, since pricing them needs an extra hop. In the tokens
  checked while building this, the USDG-quoted pools were consistently
  much smaller than the ETH-paired ones, so this wasn't worth the added
  complexity yet -- `candidateTokenFromPair` in
  `src/chain/newPairWatcher.ts` is where that logic lives if you want to
  extend it.
- **Uniswap V4 support was added after discovering it's the dominant venue
  on this chain**, not V2/V3 as initially assumed -- two real example
  tokens checked while building this (TENSOR, WAIFU) were both V4-only
  with $100k-$5M in 24h volume, and were invisible to the bot before this
  was added. V4 has no per-pool contract; a singleton `PoolManager`
  (`UNISWAP_V4_POOL_MANAGER` in `src/decode/uniswapAbi.ts`) emits
  `Initialize` (new pool) and `Swap` events for every pool chain-wide,
  keyed by a `poolId` instead of a deployed address --
  `src/chain/poolRegistry.ts`'s cache is keyed generically by string so it
  handles both address-keyed (V2/V3) and poolId-keyed (V4) pools. V4's
  event ABI is stable across every chain it's deployed to (only
  `PoolManager`'s address differs per chain), so those signatures are from
  Uniswap's v4-core source, not guessed for this chain.
- **ScanHood's simulation appears unreliable for V4 pools specifically.**
  One example token scanned during testing got a false DANGER/honeypot
  verdict -- ScanHood's response showed it testing against a near-zero-
  liquidity pool, while Dexscreener showed a real, actively-trading V4
  pool with six-figure liquidity for the same token. If a token you know
  is trading fine keeps failing the safety check, this may be why --
  ScanHood may not always be finding/testing the actual active V4 pool.
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
  decode/                 Uniswap V2/V3/V4 event + calldata ABIs, swap decoder
  wallets/                candidate discovery + profitability scoring
  signals/                hot-token screening + the signal engine
  telegram/               alert delivery
  scripts/                one-off discovery/scoring runners
  index.ts                main process: wires everything + cron
```
