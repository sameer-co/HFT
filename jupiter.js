// Thin client for Jupiter's Swap API.
// Docs: https://dev.jup.ag/docs/swap  (this uses the Router build path:
// GET /swap/v1/quote + POST /swap/v1/swap, which are free/no-key on
// lite-api.jup.ag and carry ZERO Jupiter commission on manual/API swaps -
// see https://docs.jup.ag/user-docs/trade/spot/fees ("Manual Mode: 0%").
// The only real costs are the Solana network fee and whatever fee is
// baked into the AMM pool's route (both measured empirically by tracker.js).

const LITE_BASE = 'https://lite-api.jup.ag/swap/v1';
const PAID_BASE = 'https://api.jup.ag/swap/v1';

function baseUrl(apiKey) {
  return apiKey ? PAID_BASE : LITE_BASE;
}
function authHeaders(apiKey) {
  return apiKey ? { 'x-api-key': apiKey } : {};
}

async function fetchWithRetry(url, opts = {}, retries = 3) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw lastErr || new Error('fetch failed after retries');
}

/**
 * Get a swap quote.
 * amount must be an integer string/number in the input token's base units
 * (e.g. USDC has 6 decimals, SOL/WSOL has 9).
 */
export async function getQuote({ inputMint, outputMint, amount, slippageBps, apiKey }) {
  const url = new URL(`${baseUrl(apiKey)}/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', String(slippageBps));

  const res = await fetchWithRetry(url.toString(), { headers: authHeaders(apiKey) });
  if (!res.ok) {
    throw new Error(`Jupiter /quote failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/**
 * Build a serialized swap transaction from a quote. Caller signs and sends it.
 * wrapAndUnwrapSol is forced to false so that SOL received from a swap stays
 * as a WSOL SPL token balance (trackable) instead of merging into the
 * wallet's native SOL balance (which is reserved for gas, not trading capital).
 */
export async function getSwapTransaction({ quoteResponse, userPublicKey, apiKey }) {
  const res = await fetchWithRetry(`${baseUrl(apiKey)}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  if (!res.ok) {
    throw new Error(`Jupiter /swap failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}
