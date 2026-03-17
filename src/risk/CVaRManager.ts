/**
 * CVaRManager — APEX-2026 Phase 4 (P4.1.2)
 *
 * Conditional Value-at-Risk (Expected Shortfall) computation
 * on the last N trades to penalize tail risk.
 *
 * CVaR at α=5%: average loss in the worst 5% of trades.
 * If CVaR exceeds threshold (-15% default), reduces Kelly η by 50%.
 *
 * Also computes:
 *   - VaR (Value at Risk) at 5%
 *   - Sharpe ratio (annualized)
 *   - Max drawdown
 *   - Win rate
 */

export interface RiskMetrics {
  cvar5: number;           // CVaR at 5% — average of worst 5% returns
  var5: number;            // VaR at 5% — worst return at 5th percentile
  sharpe: number;          // Sharpe ratio (annualized assuming 1-min trades)
  maxDrawdown: number;     // Max peak-to-trough drawdown
  winRate: number;         // Fraction of positive returns
  tradeCount: number;
  kellyMultiplier: number; // 0.5 if CVaR breached, 1.0 otherwise
}

const MAX_TRADES = 200;
const CVAR_ALPHA = 0.05;      // 5% tail
const CVAR_THRESHOLD = -0.15; // -15% → trigger risk reduction
const KELLY_REDUCTION = 0.5;  // Reduce Kelly by 50% when triggered

export class CVaRManager {
  private returns: number[] = []; // log returns of past trades
  private equityCurve: number[] = [1.0]; // cumulative equity
  private stats = {
    updates: 0,
    breaches: 0,
  };

  constructor() {
    console.log('🛡️ [CVaRManager] Initialized (α=5%, threshold=-15%)');
  }

  /**
   * Record a trade return (log return).
   */
  recordReturn(logReturn: number): void {
    this.stats.updates++;
    this.returns.push(logReturn);

    // Update equity curve
    const lastEquity = this.equityCurve[this.equityCurve.length - 1] ?? 1.0;
    this.equityCurve.push(lastEquity * Math.exp(logReturn));

    // Evict old
    if (this.returns.length > MAX_TRADES) {
      this.returns.shift();
    }
    if (this.equityCurve.length > MAX_TRADES + 1) {
      this.equityCurve.shift();
    }
  }

  /**
   * Compute full risk metrics.
   */
  compute(): RiskMetrics {
    const n = this.returns.length;

    if (n < 5) {
      return {
        cvar5: 0,
        var5: 0,
        sharpe: 0,
        maxDrawdown: 0,
        winRate: 0.5,
        tradeCount: n,
        kellyMultiplier: 1.0,
      };
    }

    // Sort returns ascending for percentile computation
    const sorted = [...this.returns].sort((a, b) => a - b);

    // VaR at α
    const varIndex = Math.max(0, Math.floor(n * CVAR_ALPHA) - 1);
    const var5 = sorted[varIndex]!;

    // CVaR: average of returns below VaR
    const tailCount = Math.max(1, Math.floor(n * CVAR_ALPHA));
    let tailSum = 0;
    for (let i = 0; i < tailCount; i++) {
      tailSum += sorted[i]!;
    }
    const cvar5 = tailSum / tailCount;

    // Sharpe ratio
    const mean = this.returns.reduce((s, r) => s + r, 0) / n;
    const variance = this.returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    // Annualized assuming ~525,600 minutes/year, trades every ~5min
    const tradesPerYear = 525_600 / 5;
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(tradesPerYear) : 0;

    // Max drawdown from equity curve
    let peak = -Infinity;
    let maxDrawdown = 0;
    for (const equity of this.equityCurve) {
      if (equity > peak) peak = equity;
      const dd = (equity - peak) / peak;
      if (dd < maxDrawdown) maxDrawdown = dd;
    }

    // Win rate
    const wins = this.returns.filter((r) => r > 0).length;
    const winRate = n > 0 ? wins / n : 0.5;

    // Kelly multiplier: reduce if CVaR breached
    let kellyMultiplier = 1.0;
    if (cvar5 < CVAR_THRESHOLD) {
      kellyMultiplier = KELLY_REDUCTION;
      this.stats.breaches++;
    }

    return {
      cvar5,
      var5,
      sharpe,
      maxDrawdown,
      winRate,
      tradeCount: n,
      kellyMultiplier,
    };
  }

  /**
   * Quick Kelly multiplier lookup. Hot path safe.
   */
  getKellyMultiplier(): number {
    return this.compute().kellyMultiplier;
  }

  getStats() {
    return { ...this.stats, tradeCount: this.returns.length };
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _cvar: CVaRManager | null = null;

export function getCVaRManager(): CVaRManager {
  if (!_cvar) {
    _cvar = new CVaRManager();
  }
  return _cvar;
}
