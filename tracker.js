import fs from 'fs';
import path from 'path';

// Tracks costs the way the user actually experiences them:
//  - networkFeeUsd: the exact Solana tx fee (live mode) or an estimate
//    (simulation mode), converted to USD.
//  - marketCostUsd per round trip: usdcIn - usdcOut. This single number
//    empirically captures EVERYTHING baked into the swap rate - AMM pool
//    fee, price impact/slippage, and bid/ask spread - without needing to
//    guess at a bps figure, because it's measured from real quotes.
export class CostTracker {
  constructor({ startingCapitalUsd, logPath }) {
    this.startingCapitalUsd = startingCapitalUsd;
    this.roundTrips = 0;
    this.totalNetworkFeeUsd = 0;
    this.totalMarketCostUsd = 0;
    this.logPath = logPath;
    this._ensureLog();
  }

  _ensureLog() {
    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.logPath)) {
      fs.writeFileSync(
        this.logPath,
        'timestamp,action,amountIn,amountOut,networkFeeUsd,priceImpactPct\n'
      );
    }
  }

  recordLeg({ action, amountIn, amountOut, networkFeeUsd, priceImpactPct }) {
    const row = [
      new Date().toISOString(),
      action,
      amountIn,
      amountOut,
      networkFeeUsd.toFixed(6),
      priceImpactPct ?? '',
    ].join(',');
    fs.appendFileSync(this.logPath, row + '\n');
    this.totalNetworkFeeUsd += networkFeeUsd;
  }

  closeRoundTrip({ usdcIn, usdcOut, currentUsdcBalance }) {
    this.roundTrips += 1;
    const marketCost = usdcIn - usdcOut; // positive = lost value, negative = gained
    this.totalMarketCostUsd += marketCost;
    const totalPnl = currentUsdcBalance - this.startingCapitalUsd;
    return {
      marketCost,
      totalPnl,
      totalPnlPct: (totalPnl / this.startingCapitalUsd) * 100,
    };
  }

  summary(currentUsdcBalance) {
    const totalPnl = currentUsdcBalance - this.startingCapitalUsd;
    return {
      roundTrips: this.roundTrips,
      totalNetworkFeeUsd: this.totalNetworkFeeUsd,
      totalMarketCostUsd: this.totalMarketCostUsd,
      totalPnl,
      totalPnlPct: (totalPnl / this.startingCapitalUsd) * 100,
      currentUsdcBalance,
    };
  }
}
