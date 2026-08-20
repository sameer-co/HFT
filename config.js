import 'dotenv/config';

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return v.toLowerCase() === 'true';
}
function num(v, def) {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const config = {
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
};

export function validateConfig() {
  const problems = [];
  if (!config.simulationMode) {
    if (!config.privateKey) problems.push('PRIVATE_KEY is required when SIMULATION_MODE=false');
    if (!config.rpcUrl) problems.push('RPC_URL is required when SIMULATION_MODE=false');
  }
  if (config.startingCapitalUsd <= 0) problems.push('STARTING_CAPITAL_USD must be > 0');
  if (problems.length) {
    throw new Error('Config problems:\n - ' + problems.join('\n - '));
  }
}
