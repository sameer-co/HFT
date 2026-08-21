// Solana Flip Bot (USDC <-> SOL via Jupiter) — single-file version
// Persistence: Neon (Postgres) instead of local files. This means no
// volume/disk to configure on whatever host you deploy to — the DB
// connection string is the only thing that needs to survive a restart,
// and Neon (or any Postgres) already does that for you.
//
// Cycle: buy SOL with USDC -> hold N seconds -> sell SOL back to USDC ->
// cooldown N seconds -> repeat. Reports costs to Telegram every cycle,
// plus an independent heartbeat every 5 minutes.
//
// Run:  npm install && npm start
// Required env: DATABASE_URL (Neon/Postgres connection string).
// See .env.example for everything else.

import 'dotenv/config';
import pg from 'pg';
import { Connection, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// ============================================================
// CONFIG
// ============================================================
function bool(v, def) {
  if (v === undefined || v === '') return def;
  return v.toLowerCase() === 'true';
}
function num(v, def) {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const config = {
  simulationMode: bool(process.env.SIMULATION_MODE, true),

  startingCapitalUsd: num(process.env.STARTING_CAPITAL_USD, 100),
  useFullBalance: bool(process.env.USE_FULL_BALANCE, true),
  tradeAmountUsdc: num(process.env.TRADE_AMOUNT_USDC, 10),

  holdSeconds: num(process.env.HOLD_SECONDS, 5),
  cooldownSeconds: num(process.env.COOLDOWN_SECONDS, 5),

  rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  privateKey: process.env.PRIVATE_KEY || '',

  jupiterApiKey: process.env.JUPITER_API_KEY || '',
  slippageBps: num(process.env.SLIPPAGE_BPS, 50),

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  reportEveryNCycles: Math.max(1, num(process.env.REPORT_EVERY_N_CYCLES, 1)),

  databaseUrl: process.env.DATABASE_URL || '',
};

function validateConfig() {
  const problems = [];
  if (!config.databaseUrl) {
    problems.push(
      'DATABASE_URL is required (a Neon/Postgres connection string) - this is what makes the bot ' +
        'survive restarts without losing its balance/P&L history. Create a free project at neon.tech, ' +
        'copy its connection string, and set DATABASE_URL.'
    );
  }
  if (!config.simulationMode) {
    if (!config.privateKey) problems.push('PRIVATE_KEY is required when SIMULATION_MODE=false');
    if (!config.rpcUrl) problems.push('RPC_URL is required when SIMULATION_MODE=false');
  }
  if (config.startingCapitalUsd <= 0) problems.push('STARTING_CAPITAL_USD must be > 0');
  if (problems.length) {
    throw new Error('Config problems:\n - ' + problems.join('\n - '));
  }
}
validateConfig();

// ============================================================
// CONSTANTS
// ============================================================
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112'; // wrapped SOL mint
const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;

// Simulation-only estimate: 5,000 lamport base fee + a small priority-fee
// allowance. Live mode reads the ACTUAL fee off-chain instead of this.
const EST_TX_FEE_LAMPORTS = 7000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toBaseUnits = (amountUi, decimals) => Math.round(amountUi * 10 ** decimals).toString();
const fromBaseUnits = (amountBase, decimals) => Number(amountBase) / 10 ** decimals;

// ============================================================
// TELEGRAM
// ============================================================
async function sendTelegramMessage(text) {
  if (!config.telegramBotToken || !config.telegramChatId) {
    console.log('[telegram not configured]\n' + text + '\n');
    return;
  }
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegramChatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      console.error('Telegram send failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('Telegram send error:', err.message);
  }
}
const tg = (text) => sendTelegramMessage(text);

// ============================================================
// JUPITER SWAP API CLIENT
// Docs: https://dev.jup.ag/docs/swap. Uses lite-api.jup.ag (free, no key,
// zero Jupiter commission on manual/API swaps - the 0-0.5% "Ultra Mode" fee
// only applies to trades placed through the jup.ag website, not this API).
// ============================================================
const LITE_BASE = 'https://lite-api.jup.ag/swap/v1';
const PAID_BASE = 'https://api.jup.ag/swap/v1';
const jupBaseUrl = () => (config.jupiterApiKey ? PAID_BASE : LITE_BASE);
const jupAuthHeaders = () => (config.jupiterApiKey ? { 'x-api-key': config.jupiterApiKey } : {});

async function fetchWithRetry(url, opts = {}, retries = 3) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429) {
        await sleep(1000 * 2 ** i);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      await sleep(500 * 2 ** i);
    }
  }
  throw lastErr || new Error('fetch failed after retries');
}

async function getQuote({ inputMint, outputMint, amount }) {
  const url = new URL(`${jupBaseUrl()}/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', String(config.slippageBps));

  const res = await fetchWithRetry(url.toString(), { headers: jupAuthHeaders() });
  if (!res.ok) throw new Error(`Jupiter /quote failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// wrapAndUnwrapSol forced false so SOL received from a swap stays as a
// WSOL SPL token balance (trackable) instead of merging into the wallet's
// native SOL balance (reserved for gas, not trading capital).
async function getSwapTransaction({ quoteResponse, userPublicKey }) {
  const res = await fetchWithRetry(`${jupBaseUrl()}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...jupAuthHeaders() },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  if (!res.ok) throw new Error(`Jupiter /swap failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// ============================================================
// SOLANA WALLET (live mode only)
// ============================================================
function loadKeypair(privateKeyBase58) {
  if (!privateKeyBase58) {
    throw new Error('PRIVATE_KEY is not set (required when SIMULATION_MODE=false)');
  }
  return Keypair.fromSecretKey(bs58.decode(privateKeyBase58.trim()));
}

// ============================================================
// DATABASE (Neon/Postgres) — replaces logs/trades.csv + logs/state.json
// ============================================================
const { Pool } = pg;
// rejectUnauthorized: false is the standard workaround for `pg` + Neon's
// SSL cert chain; safe here since this is a direct provider connection,
// not a browser context. Neon connection strings already include
// ?sslmode=require - this just satisfies node's TLS verification for it.
// If DATABASE_URL explicitly opts out (?sslmode=disable - e.g. a local
// Postgres for testing), respect that instead of forcing SSL.
const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
  max: 5,
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      starting_capital_usd DOUBLE PRECISION NOT NULL,
      round_trips INTEGER NOT NULL DEFAULT 0,
      total_network_fee_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_market_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      usdc_balance DOUBLE PRECISION NOT NULL,
      sol_balance DOUBLE PRECISION NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      action TEXT NOT NULL,
      amount_in DOUBLE PRECISION NOT NULL,
      amount_out DOUBLE PRECISION NOT NULL,
      network_fee_usd DOUBLE PRECISION NOT NULL,
      price_impact_pct TEXT
    );
  `);
}

// Tracks costs the way the user actually experiences them:
//  - networkFeeUsd: the exact Solana tx fee (live mode) or an estimate
//    (simulation mode), converted to USD.
//  - marketCostUsd per round trip: usdcIn - usdcOut. Empirically captures
//    AMM pool fee + price impact/slippage + spread, measured from real
//    quotes rather than assumed.
//  - totalPnl = trading-balance change MINUS cumulative network fees paid
//    (fees are real money spent - paid from a separate SOL gas stash in
//    live mode, so they never show up in the USDC/SOL balance itself and
//    have to be subtracted explicitly here).
//
// PERSISTENCE: every leg and cycle-end, the running totals + latest known
// balances are upserted into the single `bot_state` row in Postgres. On
// startup, load() restores that row instead of starting fresh - so a
// restart (crash, redeploy) resumes the real balance/round-trip history
// instead of silently resetting to STARTING_CAPITAL_USD.
const tracker = {
  startingCapitalUsd: config.startingCapitalUsd,
  roundTrips: 0,
  totalNetworkFeeUsd: 0,
  totalMarketCostUsd: 0,
  resumed: false,
  restoredBalances: null,

  async load() {
    const { rows } = await pool.query('SELECT * FROM bot_state WHERE id = 1');
    if (!rows.length) return;
    const r = rows[0];
    this.startingCapitalUsd = Number(r.starting_capital_usd);
    this.roundTrips = r.round_trips;
    this.totalNetworkFeeUsd = Number(r.total_network_fee_usd);
    this.totalMarketCostUsd = Number(r.total_market_cost_usd);
    this.restoredBalances = { usdcBalance: Number(r.usdc_balance), solBalance: Number(r.sol_balance) };
    this.resumed = true;
  },

  async persist(usdcBalance, solBalance) {
    await pool.query(
      `INSERT INTO bot_state (id, starting_capital_usd, round_trips, total_network_fee_usd, total_market_cost_usd, usdc_balance, sol_balance, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (id) DO UPDATE SET
         round_trips = EXCLUDED.round_trips,
         total_network_fee_usd = EXCLUDED.total_network_fee_usd,
         total_market_cost_usd = EXCLUDED.total_market_cost_usd,
         usdc_balance = EXCLUDED.usdc_balance,
         sol_balance = EXCLUDED.sol_balance,
         updated_at = now()`,
      [this.startingCapitalUsd, this.roundTrips, this.totalNetworkFeeUsd, this.totalMarketCostUsd, usdcBalance, solBalance]
    );
  },

  async recordLeg({ action, amountIn, amountOut, networkFeeUsd, priceImpactPct }) {
    await pool.query(
      `INSERT INTO trades (action, amount_in, amount_out, network_fee_usd, price_impact_pct) VALUES ($1,$2,$3,$4,$5)`,
      [action, amountIn, amountOut, networkFeeUsd, priceImpactPct ?? null]
    );
    this.totalNetworkFeeUsd += networkFeeUsd;
  },

  closeRoundTrip({ usdcIn, usdcOut, currentUsdcBalance }) {
    this.roundTrips += 1;
    const marketCost = usdcIn - usdcOut; // positive = lost value, negative = gained
    this.totalMarketCostUsd += marketCost;
    const totalPnl = currentUsdcBalance - this.startingCapitalUsd - this.totalNetworkFeeUsd;
    return { marketCost, totalPnl, totalPnlPct: (totalPnl / this.startingCapitalUsd) * 100 };
  },

  summary(currentUsdcBalance) {
    const totalPnl = currentUsdcBalance - this.startingCapitalUsd - this.totalNetworkFeeUsd;
    return {
      roundTrips: this.roundTrips,
      totalNetworkFeeUsd: this.totalNetworkFeeUsd,
      totalMarketCostUsd: this.totalMarketCostUsd,
      totalPnl,
      totalPnlPct: (totalPnl / this.startingCapitalUsd) * 100,
      currentUsdcBalance,
    };
  },
};

// ============================================================
// STATE
// ============================================================
// Seeded properly (fresh vs resumed) inside main(), after tracker.load()
// has had a chance to run. Live mode overwrites these with real on-chain
// balances regardless.
const state = { usdcBalance: config.startingCapitalUsd, solBalance: 0 };

const startedAt = Date.now();
let legInFlight = false; // true whenever a swap is mid-flight (for shutdown warnings)

let connection, keypair;
if (!config.simulationMode) {
  connection = new Connection(config.rpcUrl, 'confirmed');
  keypair = loadKeypair(config.privateKey);
}

async function tokenBalance(owner, mint) {
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
  if (!accounts.value.length) return 0;
  return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
}

// Trading SOL is kept as a WSOL token balance (wrapAndUnwrapSol: false)
// so it never mixes with the wallet's native SOL, reserved for gas.
async function refreshLiveBalances() {
  state.usdcBalance = await tokenBalance(keypair.publicKey, USDC_MINT);
  state.solBalance = await tokenBalance(keypair.publicKey, SOL_MINT);
}

async function executeLiveSwap(quote) {
  const { swapTransaction } = await getSwapTransaction({
    quoteResponse: quote,
    userPublicKey: keypair.publicKey.toBase58(),
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([keypair]);

  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, ...latestBlockhash }, 'confirmed');

  const detail = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  const feeLamports = detail?.meta?.fee ?? EST_TX_FEE_LAMPORTS;
  return { signature, feeLamports };
}

/** Execute one leg (BUY or SELL) and record its cost. Returns output amount + fee in USD. */
async function doLeg(action, inputMint, outputMint, inputAmountUi, inputDecimals, outputDecimals) {
  const amountBase = toBaseUnits(inputAmountUi, inputDecimals);
  const quote = await getQuote({ inputMint, outputMint, amount: amountBase });
  const outputAmountUi = fromBaseUnits(quote.outAmount, outputDecimals);

  legInFlight = true;
  let feeLamports;
  if (config.simulationMode) {
    feeLamports = EST_TX_FEE_LAMPORTS;
  } else {
    ({ feeLamports } = await executeLiveSwap(quote));
  }
  legInFlight = false;

  // USD-per-SOL = usdcAmount / solAmount, figured from whichever side of
  // this leg is USDC vs SOL (not from which side happens to be "input" -
  // that inverts the ratio).
  const solAmountUi = outputMint === SOL_MINT ? outputAmountUi : inputAmountUi;
  const usdcAmountUi = outputMint === SOL_MINT ? inputAmountUi : outputAmountUi;
  const solPriceUsd = usdcAmountUi / solAmountUi;
  const feeUsd = (feeLamports / LAMPORTS_PER_SOL) * solPriceUsd;

  await tracker.recordLeg({
    action,
    amountIn: inputAmountUi,
    amountOut: outputAmountUi,
    networkFeeUsd: feeUsd,
    priceImpactPct: quote.priceImpactPct,
  });

  return { outputAmountUi, feeUsd };
}

// Values any currently-held SOL in USD via a fresh quote (does not trade)
// so status reports never just ignore an open position mid-hold.
async function getEffectiveUsdcBalance() {
  if (state.solBalance <= 0) {
    return { effectiveUsdcBalance: state.usdcBalance, note: '' };
  }
  try {
    const amountBase = toBaseUnits(state.solBalance, SOL_DECIMALS);
    const quote = await getQuote({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: amountBase });
    const estUsdcValue = fromBaseUnits(quote.outAmount, USDC_DECIMALS);
    return {
      effectiveUsdcBalance: state.usdcBalance + estUsdcValue,
      note: `\n⚠️ Open position not sold back: ${state.solBalance.toFixed(6)} SOL (≈ $${estUsdcValue.toFixed(4)}, included below)`,
    };
  } catch (err) {
    return {
      effectiveUsdcBalance: state.usdcBalance,
      note: `\n⚠️ Open position not sold back: ${state.solBalance.toFixed(6)} SOL - couldn't fetch a value (${err.message}). NOT included below.`,
    };
  }
}

function formatUptime(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function runCycle(cycleNum) {
  const usdcToSpend = config.useFullBalance
    ? state.usdcBalance
    : Math.min(config.tradeAmountUsdc, state.usdcBalance);

  if (usdcToSpend < 0.02) {
    await tg(`⚠️ Cycle #${cycleNum}: USDC balance too low to trade (${state.usdcBalance.toFixed(4)}). Stopping bot.`);
    process.exit(0);
  }

  // --- BUY: USDC -> SOL ---
  const buy = await doLeg('BUY', USDC_MINT, SOL_MINT, usdcToSpend, USDC_DECIMALS, SOL_DECIMALS);
  if (config.simulationMode) {
    state.usdcBalance -= usdcToSpend;
    state.solBalance += buy.outputAmountUi;
  } else {
    await refreshLiveBalances();
  }
  await tracker.persist(state.usdcBalance, state.solBalance);

  await sleep(config.holdSeconds * 1000);

  // --- SELL: SOL -> USDC ---
  const solToSell = state.solBalance;
  const sell = await doLeg('SELL', SOL_MINT, USDC_MINT, solToSell, SOL_DECIMALS, USDC_DECIMALS);
  if (config.simulationMode) {
    state.solBalance -= solToSell;
    state.usdcBalance += sell.outputAmountUi;
  } else {
    await refreshLiveBalances();
  }
  await tracker.persist(state.usdcBalance, state.solBalance);

  const { marketCost, totalPnl, totalPnlPct } = tracker.closeRoundTrip({
    usdcIn: usdcToSpend,
    usdcOut: sell.outputAmountUi,
    currentUsdcBalance: state.usdcBalance,
  });

  if (cycleNum % config.reportEveryNCycles === 0) {
    const s = tracker.summary(state.usdcBalance);
    const cycleFeeUsd = buy.feeUsd + sell.feeUsd;
    const text =
      `📊 <b>Cycle #${cycleNum}</b> (${config.simulationMode ? 'SIMULATION' : 'LIVE'})\n` +
      `Bought ${buy.outputAmountUi.toFixed(6)} SOL with ${usdcToSpend.toFixed(4)} USDC\n` +
      `Sold ${solToSell.toFixed(6)} SOL for ${sell.outputAmountUi.toFixed(4)} USDC\n` +
      `Round-trip cost: ${marketCost >= 0 ? '-' : '+'}$${Math.abs(marketCost).toFixed(4)} ` +
      `(fees + slippage + spread)\n` +
      `Network fee this cycle: $${cycleFeeUsd.toFixed(5)}\n` +
      `──────────\n` +
      `💰 Balance: ${state.usdcBalance.toFixed(4)} USDC (started at $${tracker.startingCapitalUsd})\n` +
      `${totalPnl >= 0 ? '📈' : '📉'} Total P&L: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} USD ` +
      `(${totalPnlPct.toFixed(3)}%)\n` +
      `⛽ Total network fees: $${s.totalNetworkFeeUsd.toFixed(5)}\n` +
      `🌊 Total market cost: $${s.totalMarketCostUsd.toFixed(4)}\n` +
      `🔁 Round trips: ${s.roundTrips}`;
    await tg(text);
  }

  await sleep(config.cooldownSeconds * 1000);
}

async function main() {
  console.log(`Mode: ${config.simulationMode ? 'SIMULATION (no real funds)' : 'LIVE (real funds)'}`);
  console.log(`Starting capital: $${config.startingCapitalUsd}`);
  console.log('Persistence: Postgres (Neon) via DATABASE_URL');

  await ensureSchema();
  await tracker.load();

  // Resume from the checkpoint if one exists, instead of silently starting
  // a fresh paper balance while the DB keeps accumulating trade rows.
  if (tracker.resumed) {
    state.usdcBalance = tracker.restoredBalances.usdcBalance;
    state.solBalance = tracker.restoredBalances.solBalance;
  }

  if (!config.simulationMode) {
    console.log('Wallet:', keypair.publicKey.toBase58());
    await refreshLiveBalances();
    console.log(`On-chain balances -> USDC: ${state.usdcBalance}, WSOL: ${state.solBalance}`);
  }

  if (tracker.resumed) {
    console.log(
      `Resumed from checkpoint -> USDC: ${state.usdcBalance}, SOL: ${state.solBalance}, ` +
        `round trips so far: ${tracker.roundTrips}, lifetime baseline: $${tracker.startingCapitalUsd}`
    );
    await tg(
      `🔄 Bot resumed from a previous checkpoint (not a fresh start).\n` +
        `Balance: ${state.usdcBalance.toFixed(4)} USDC${state.solBalance > 0 ? ` + ${state.solBalance.toFixed(6)} SOL` : ''}\n` +
        `Round trips so far: ${tracker.roundTrips} | Lifetime baseline: $${tracker.startingCapitalUsd}`
    );

    // A checkpoint saved mid-cycle (e.g. an ungraceful crash between BUY and
    // SELL) leaves capital parked in SOL. Without this, state.usdcBalance
    // would be ~0 and the bot would immediately trip the "balance too low"
    // guard below and shut itself down on its first tick after every resume.
    if (config.simulationMode && state.solBalance > 0) {
      console.log(`Closing out ${state.solBalance} SOL left open from before the restart...`);
      const closeout = await doLeg('SELL', SOL_MINT, USDC_MINT, state.solBalance, SOL_DECIMALS, USDC_DECIMALS);
      state.solBalance = 0;
      state.usdcBalance += closeout.outputAmountUi;
      await tracker.persist(state.usdcBalance, state.solBalance);
      await tg(
        `🔁 Closed out the leftover open position: sold back to ${state.usdcBalance.toFixed(4)} USDC. Resuming normal cycles.`
      );
    }
    // Live mode doesn't need this - refreshLiveBalances() already read the
    // true on-chain USDC + WSOL balances above.
  } else {
    await tracker.persist(state.usdcBalance, state.solBalance); // create the row so future resumes have something to load
    await tg(
      `🚀 Bot started (${config.simulationMode ? 'SIMULATION' : 'LIVE'}). ` +
        `Starting capital: $${config.startingCapitalUsd}. ` +
        `Hold ${config.holdSeconds}s / cooldown ${config.cooldownSeconds}s.`
    );
  }

  // Heartbeat: an independent "still alive, here's where things stand"
  // update every 5 minutes, regardless of cycle count or reportEveryNCycles.
  const HEARTBEAT_MS = 5 * 60 * 1000;
  const heartbeatTimer = setInterval(async () => {
    try {
      const { effectiveUsdcBalance, note } = await getEffectiveUsdcBalance();
      const s = tracker.summary(effectiveUsdcBalance);
      await tg(
        `💓 Heartbeat (${config.simulationMode ? 'SIMULATION' : 'LIVE'}) - uptime ${formatUptime(Date.now() - startedAt)}\n` +
          `Balance: ${effectiveUsdcBalance.toFixed(4)} USDC\n` +
          `Total P&L: ${s.totalPnl >= 0 ? '+' : ''}${s.totalPnl.toFixed(4)} USD (${s.totalPnlPct.toFixed(3)}%)\n` +
          `Network fees: $${s.totalNetworkFeeUsd.toFixed(5)} | Market cost: $${s.totalMarketCostUsd.toFixed(4)}\n` +
          `Round trips: ${s.roundTrips}` +
          note
      );
    } catch (err) {
      console.error('Heartbeat error:', err.message);
    }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  let shuttingDown = false;
  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeatTimer);

    const { effectiveUsdcBalance, note } = await getEffectiveUsdcBalance();
    let openPositionLine = note;
    if (legInFlight) {
      openPositionLine +=
        `\n⚠️ A swap was in progress when this signal arrived` +
        (config.simulationMode ? '.' : ' - verify on-chain that it landed before trusting these numbers.');
    }

    const s = tracker.summary(effectiveUsdcBalance);
    await tg(
      `🛑 Bot stopped (${signal}).\n` +
        `Final balance: ${effectiveUsdcBalance.toFixed(4)} USDC` +
        (state.solBalance > 0 ? ' (incl. est. value of unsold SOL)' : '') +
        `\n` +
        `Total P&L: ${s.totalPnl.toFixed(4)} USD (${s.totalPnlPct.toFixed(3)}%)\n` +
        `Network fees paid: $${s.totalNetworkFeeUsd.toFixed(5)}\n` +
        `Market cost paid: $${s.totalMarketCostUsd.toFixed(4)}\n` +
        `Round trips: ${s.roundTrips}` +
        openPositionLine
    );
    await pool.end().catch(() => {});
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    tg(`❌ Unhandled error, bot may be unstable: ${err?.message ?? err}`).finally(() =>
      gracefulShutdown('unhandledRejection')
    );
  });

  let cycleNum = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    cycleNum += 1;
    try {
      await runCycle(cycleNum);
    } catch (err) {
      console.error(`Cycle #${cycleNum} error:`, err.message);
      await tg(`❌ Error in cycle #${cycleNum}: ${err.message}`);
      await sleep(5000);
    }
  }
}

main();
