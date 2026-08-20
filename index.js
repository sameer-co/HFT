import { Connection, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { config, validateConfig } from './src/config.js';
import { getQuote, getSwapTransaction } from './src/jupiter.js';
import { sendTelegramMessage } from './src/telegram.js';
import { CostTracker } from './src/tracker.js';
import { loadKeypair } from './src/wallet.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112'; // wrapped SOL mint
const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;

// Simulation-only estimate: 5,000 lamport base fee + a small priority-fee
// allowance. Real network fees under normal conditions run well under a
// cent (see README). Live mode reads the ACTUAL fee off-chain instead of
// using this number.
const EST_TX_FEE_LAMPORTS = 7000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toBaseUnits = (amountUi, decimals) => Math.round(amountUi * 10 ** decimals).toString();
const fromBaseUnits = (amountBase, decimals) => Number(amountBase) / 10 ** decimals;

validateConfig();

const tg = (text) =>
  sendTelegramMessage({ botToken: config.telegramBotToken, chatId: config.telegramChatId, text });

const tracker = new CostTracker({
  startingCapitalUsd: config.startingCapitalUsd,
  logPath: './logs/trades.csv',
});

const state = {
  usdcBalance: config.startingCapitalUsd,
  solBalance: 0,
};

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

// In live mode, trading SOL is kept as a WSOL token balance (see jupiter.js
// wrapAndUnwrapSol: false) so it never mixes with the wallet's native SOL,
// which is reserved for paying network fees.
async function refreshLiveBalances() {
  state.usdcBalance = await tokenBalance(keypair.publicKey, USDC_MINT);
  state.solBalance = await tokenBalance(keypair.publicKey, SOL_MINT);
}

async function executeLiveSwap(quote) {
  const { swapTransaction } = await getSwapTransaction({
    quoteResponse: quote,
    userPublicKey: keypair.publicKey.toBase58(),
    apiKey: config.jupiterApiKey,
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
  const quote = await getQuote({
    inputMint,
    outputMint,
    amount: amountBase,
    slippageBps: config.slippageBps,
    apiKey: config.jupiterApiKey,
  });
  const outputAmountUi = fromBaseUnits(quote.outAmount, outputDecimals);

  let feeLamports;
  if (config.simulationMode) {
    feeLamports = EST_TX_FEE_LAMPORTS;
  } else {
    ({ feeLamports } = await executeLiveSwap(quote));
  }

  // Convert the lamport fee to USD using this trade's own implied SOL price
  // (no separate price feed needed - USDC ~= $1).
  const solPriceUsd =
    inputMint === SOL_MINT ? inputAmountUi / outputAmountUi : outputAmountUi / inputAmountUi;
  const feeUsd = (feeLamports / LAMPORTS_PER_SOL) * solPriceUsd;

  tracker.recordLeg({
    action,
    amountIn: inputAmountUi,
    amountOut: outputAmountUi,
    networkFeeUsd: feeUsd,
    priceImpactPct: quote.priceImpactPct,
  });

  return { outputAmountUi, feeUsd };
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
      `💰 Balance: ${state.usdcBalance.toFixed(4)} USDC (started at $${config.startingCapitalUsd})\n` +
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

  if (!config.simulationMode) {
    console.log('Wallet:', keypair.publicKey.toBase58());
    await refreshLiveBalances();
    console.log(`On-chain balances -> USDC: ${state.usdcBalance}, WSOL: ${state.solBalance}`);
  }

  await tg(
    `🚀 Bot started (${config.simulationMode ? 'SIMULATION' : 'LIVE'}). ` +
      `Starting capital: $${config.startingCapitalUsd}. ` +
      `Hold ${config.holdSeconds}s / cooldown ${config.cooldownSeconds}s.`
  );

  process.on('SIGINT', async () => {
    const s = tracker.summary(state.usdcBalance);
    await tg(
      `🛑 Bot stopped.\n` +
        `Final balance: ${state.usdcBalance.toFixed(4)} USDC\n` +
        `Total P&L: ${s.totalPnl.toFixed(4)} USD (${s.totalPnlPct.toFixed(3)}%)\n` +
        `Network fees paid: $${s.totalNetworkFeeUsd.toFixed(5)}\n` +
        `Market cost paid: $${s.totalMarketCostUsd.toFixed(4)}\n` +
        `Round trips: ${s.roundTrips}`
    );
    process.exit(0);
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
