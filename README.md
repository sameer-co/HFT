# Solana Flip Bot — single-file, Neon-backed

Cycles: **buy SOL with USDC → hold 5s → sell SOL back to USDC → cooldown 5s → repeat.**
Everything lives in one file, `bot.js`. Persistence is [Neon](https://neon.tech) (serverless Postgres) instead of local log files — no volume/disk to configure on whatever host you deploy to, since the database is already durable and external.

## Why Neon instead of files

The earlier version wrote `logs/trades.csv` and `logs/state.json` to disk, which meant you had to remember to attach a persistent volume on any host with an ephemeral filesystem (Railway, most containers) — forgetting that step silently resets the bot's balance and round-trip history on every restart. Swapping in Postgres removes that whole failure mode: the connection string is the only thing that needs to persist, and Neon's free tier already does that. It also means you can `SELECT * FROM trades` from anywhere to inspect history, instead of downloading a CSV.

## What it actually costs (measured, not guessed)

| Cost | Typical size | How it's measured |
|---|---|---|
| **Solana network fee** | Base fee is a fixed 5,000 lamports/signature (~$0.0004 at $85/SOL). Priority fee is usually sub-cent — Jupiter's `auto` mode is capped at 0.005 SOL worst case. | Live mode reads the *exact* fee off the confirmed transaction. Simulation mode uses a small fixed estimate. |
| **Jupiter platform fee** | **0%.** The raw Swap API has zero commission on manual/API swaps. ([source](https://docs.jup.ag/user-docs/trade/spot/fees)) | N/A — not charged. |
| **AMM route cost** (pool fee + slippage + spread) | The real driver — paid *twice per cycle* (once each way), so it compounds over many cycles. | Measured empirically as `usdcIn − usdcOut` on every round trip. |

**Total P&L** = trading-balance change **minus** cumulative network fees paid — fees are real spend even though (in live mode) they come out of a separate SOL gas balance rather than the USDC/SOL trading balance itself, so they're subtracted explicitly rather than assumed to already be reflected.

## Setup

```bash
npm install
cp .env.example .env
# edit .env
```

### 1. Get a database

[neon.tech](https://neon.tech) → New Project → copy the connection string it gives you → put it in `DATABASE_URL`. Free tier is plenty for this. Tables (`bot_state`, `trades`) are created automatically on first run — no migration step.

### 2. Try it safely first — simulation mode (default)

`SIMULATION_MODE=true` (the default). No wallet, no funds, no risk. The bot still calls the real Jupiter API for live quotes, so the numbers it reports are real market data.

```bash
npm start
```

### 3. Telegram reports (optional but recommended)

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Send your new bot any message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` — your chat id is the `"id"` under `"chat"`. Put it in `TELEGRAM_CHAT_ID`.

Without these set, reports print to the console instead.

### 4. Going live (real funds — read this fully first)

1. Create a **dedicated** wallet for this bot. Don't reuse a wallet holding other funds.
2. Fund it with your trading capital in **USDC**, plus a small separate amount of native **SOL** for gas (~0.02–0.05 SOL). The bot never touches the gas SOL directly.
3. Export the wallet's private key in **base58** and put it in `PRIVATE_KEY`. Never share or commit this.
4. Get an RPC endpoint — the public default is rate-limited; for anything sustained, get a free key from [Helius](https://helius.dev) or [QuickNode](https://quicknode.com).
5. Set `SIMULATION_MODE=false`.
6. Start small — `USE_FULL_BALANCE=false` and a small `TRADE_AMOUNT_USDC` for your first live run, and watch several Telegram reports before trusting it unattended.

```bash
npm start
```

Stop anytime with `Ctrl+C` (or `SIGTERM`) — it sends a final P&L summary to Telegram before exiting, valuing any open SOL position instead of ignoring it.

### 5. If the bot restarts (crash, redeploy, reboot)

On startup, the bot checks `bot_state` in Postgres. If a row exists, it **resumes** — real balance, real round-trip count, real lifetime P&L baseline — instead of starting over from `STARTING_CAPITAL_USD`. You'll get a 🔄 Telegram message confirming this. If the checkpoint was saved mid-cycle (holding SOL), it sells that back to USDC first, then resumes normal cycling.

To force a clean start, either point `DATABASE_URL` at a fresh database, or run `DELETE FROM bot_state; DELETE FROM trades;` against your existing one.

## Deploying on Railway

This is a background worker (no HTTP server, no port) — don't generate a public domain for it.

1. Push this folder to GitHub, or deploy directly from your machine with the Railway CLI (`railway up`).
2. New Project → Deploy from GitHub repo. Railway auto-detects Node via Nixpacks and runs `npm install` then `npm start` — `railway.toml` in this repo just makes that explicit and sets a restart-on-failure policy.
3. Service → Variables → add everything from `.env.example`, including `DATABASE_URL` from Neon. **No volume needed** — that's the whole point of this version.
4. Deploy. Watch Telegram for the 🚀/🔄 startup message.
5. Redeploys/stops send `SIGTERM`, which the bot handles gracefully — final report to Telegram, checkpoint already up to date in Postgres, clean pool shutdown.

## Telegram messages you'll see

- 🚀 **Start** — once, on a genuinely fresh run (no existing `bot_state` row).
- 🔄 **Resumed** — instead of Start, if a checkpoint was found. Followed by 🔁 if it had to sell off a leftover open position first.
- 📊 **Cycle report** — every `REPORT_EVERY_N_CYCLES` cycles.
- 💓 **Heartbeat** — every 5 minutes on a wall-clock timer, independent of cycle count, so you always have a recent signal the bot is (or isn't) alive.
- ❌ **Error** — any cycle that throws; logged, bot keeps going.
- 🛑 **Stopped** — on `Ctrl+C`, `SIGTERM`, or an unhandled error. Values any open SOL position before reporting.

## Config reference (`.env`)

| Var | Meaning |
|---|---|
| `DATABASE_URL` | **Required.** Neon/Postgres connection string. |
| `SIMULATION_MODE` | `true` = paper trading, `false` = real funds |
| `STARTING_CAPITAL_USD` | P&L baseline — only used on a genuinely fresh run |
| `USE_FULL_BALANCE` | `true` = flip 100% of balance each cycle; `false` = flip a fixed `TRADE_AMOUNT_USDC` |
| `HOLD_SECONDS` / `COOLDOWN_SECONDS` | Wait time after buying / after selling |
| `RPC_URL`, `PRIVATE_KEY` | Solana wallet connection — live mode only |
| `JUPITER_API_KEY` | Optional; blank uses the free `lite-api.jup.ag` tier |
| `SLIPPAGE_BPS` | Max allowed slippage per swap, in basis points (50 = 0.5%) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram reporting |
| `REPORT_EVERY_N_CYCLES` | Send a Telegram message every N cycles instead of every one |

## Database schema

Created automatically on first run:

- **`bot_state`** — single row (`id = 1`): `starting_capital_usd`, `round_trips`, `total_network_fee_usd`, `total_market_cost_usd`, `usdc_balance`, `sol_balance`, `updated_at`. This is the resume checkpoint.
- **`trades`** — append-only audit log, one row per leg: `ts`, `action` (BUY/SELL), `amount_in`, `amount_out`, `network_fee_usd`, `price_impact_pct`.

## Notes

- The Solana/Jupiter API surface changes over time — if a call starts failing, check [dev.jup.ag/docs](https://dev.jup.ag/docs) before assuming the bot is broken.
- The free `lite-api.jup.ag` tier is rate-limited (~60 req/60s). Each cycle uses 2 quote calls (+2 swap-build calls live), so very short `HOLD_SECONDS`/`COOLDOWN_SECONDS` may eventually hit 429s — the client retries with backoff automatically.
- This is not financial advice — it's a tool that measures and reports the real cost of the strategy you described so you can see the numbers for yourself.
