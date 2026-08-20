# Solana Flip Bot (USDC ⇄ SOL via Jupiter)

Cycles: **buy SOL with USDC → hold 5s → sell SOL back to USDC → cooldown 5s → repeat.**
Tracks every cost involved and reports each cycle to Telegram.

## What it actually costs (measured, not guessed)

Three real cost sources, all baked into what the bot reports each cycle:

| Cost | Typical size | How it's measured |
|---|---|---|
| **Solana network fee** | Base fee is a fixed 5,000 lamports/signature (~$0.0004 at $85/SOL). Priority fee is usually sub-cent under normal conditions — Jupiter's `auto` mode is capped at 0.005 SOL worst case. | Live mode reads the *exact* fee straight off the confirmed transaction. Simulation mode uses a small fixed estimate. |
| **Jupiter platform fee** | **0%.** The raw Swap API (what this bot calls) has zero Jupiter commission on manual/API swaps — the 0–0.5% "Ultra Mode" fee only applies to trades placed through the jup.ag website, not this endpoint. ([source](https://docs.jup.ag/user-docs/trade/spot/fees)) | N/A — not charged. |
| **AMM route cost** (pool fee + slippage + spread) | This is the real driver. For the SOL/USDC pair specifically, Jupiter routes through the deepest pools, which run very tight fee tiers (low single-digit bps per leg on the best pools). | Measured empirically as `usdcIn − usdcOut` on every round trip — this single number captures whatever the *real* fee+slippage+spread was, no assumptions needed. |

**The honest takeaway:** at $10–100 trade sizes the network fee and platform fee are both close to irrelevant. The AMM route cost is small per trade but it's paid *twice per cycle* (once each way), so it compounds over many cycles. Whether you come out ahead over a session depends on whether SOL's price moves in your favor during the 5-second hold enough to outweigh that repeated cost — the bot's Telegram report will show you the real number instead of a guess.

## Setup

```bash
npm install
cp .env.example .env
# edit .env
```

### 1. Try it safely first — simulation mode (default)

`SIMULATION_MODE=true` in `.env` (the default). No wallet, no funds, no risk.
The bot still calls the real Jupiter API for live quotes, so the cost numbers
it reports are real market data — you just don't need to fund anything yet.

```bash
npm start
```

### 2. Telegram reports (optional but recommended)

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Send your new bot any message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser — your chat id is the `"id"` under `"chat"`. Put it in `TELEGRAM_CHAT_ID`.

Without these set, reports just print to the console instead.

### 3. Going live (real funds — read this fully first)

1. Create a **dedicated** wallet for this bot. Don't reuse a wallet holding other funds.
2. Fund it with:
   - Your trading capital in **USDC** (e.g. $100).
   - A **small separate amount of native SOL** for gas — ~0.02–0.05 SOL (a few dollars). This is spent on fees and is *not* part of your trading capital; the bot never touches it directly.
3. Export the wallet's private key in **base58** format and put it in `PRIVATE_KEY`. Never share this key or commit it anywhere.
4. Get an RPC endpoint — the public one in `.env.example` is fine for testing but is rate-limited; for anything sustained get a free key from [Helius](https://helius.dev) or [QuickNode](https://quicknode.com) and put it in `RPC_URL`.
5. Set `SIMULATION_MODE=false`.
6. Start small — lower `TRADE_AMOUNT_USDC` / set `USE_FULL_BALANCE=false` for your first live run, and watch the first few Telegram reports before trusting it unattended.

```bash
npm start
```

Stop anytime with `Ctrl+C` — it sends a final P&L summary to Telegram before exiting.

## Config reference (`.env`)

| Var | Meaning |
|---|---|
| `SIMULATION_MODE` | `true` = paper trading, `false` = real funds |
| `STARTING_CAPITAL_USD` | Used only to compute the P&L % shown in reports |
| `USE_FULL_BALANCE` | `true` = flip 100% of balance each cycle; `false` = flip a fixed `TRADE_AMOUNT_USDC` |
| `HOLD_SECONDS` / `COOLDOWN_SECONDS` | Wait time after buying / after selling |
| `RPC_URL`, `PRIVATE_KEY` | Solana wallet connection — live mode only |
| `JUPITER_API_KEY` | Optional; blank uses the free `lite-api.jup.ag` tier |
| `SLIPPAGE_BPS` | Max allowed slippage per swap, in basis points (50 = 0.5%) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram reporting |
| `REPORT_EVERY_N_CYCLES` | Send a Telegram message every N cycles instead of every one |

## Files

- `index.js` — main loop
- `src/jupiter.js` — Jupiter Swap API client (quote + build tx)
- `src/wallet.js` — loads the signing keypair
- `src/telegram.js` — sends reports
- `src/tracker.js` — cost/P&L accounting, writes `logs/trades.csv`
- `logs/trades.csv` — full audit trail of every leg (created on first run)

## Notes

- The Solana/Jupiter API surface does change over time — if a call starts failing, check [dev.jup.ag/docs](https://dev.jup.ag/docs) for the current endpoint shape before assuming the bot is broken.
- The free `lite-api.jup.ag` tier is rate-limited (~60 requests/60s per account). Each cycle uses 2 quote calls (+2 swap-build calls in live mode), so very short `HOLD_SECONDS`/`COOLDOWN_SECONDS` values may eventually hit 429s — the client retries with backoff automatically.
- This is not financial advice — it's a tool that measures and reports the real cost of the strategy you described so you can see the numbers for yourself.
