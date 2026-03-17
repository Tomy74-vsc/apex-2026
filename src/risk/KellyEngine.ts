/**
 * KellyEngine — APEX-2026 Phase 4 (P4.1.1)
 *
 * Fractional Kelly criterion with dynamic η adjusted by HMM regime.
 *
 * Formula: f* = η(regime) × (b×p - q) / b
 *
 * Where:
 *   b = expected win/loss ratio (odds)
 *   p = probability of win
 *   q = 1 - p
 *   η = fraction coefficient per regime
 *
 * The regime determines aggressiveness:
 *   Accumulation → η=0.30 (moderate)
 *   Trending     → η=0.50 (max aggression)
 *   Mania        → η=0.10 (extreme caution — reversals)
 *   Distribution → η=0.15 (exit phase)
 */

import type { HMMRegime } from '../bridge/types.js';

export interface PositionSizing {
  kellyFraction: number;    // f* — optimal fraction of bankroll
  positionSol: number;      // actual SOL amount to trade
  regime: HMMRegime;
  eta: number;              // η used
  winProb: number;
  odds: number;
  confidence: number;       // from AIBrain
  cvarAdjustment: number;   // multiplier from CVaR (0.5 to 1.0)
}

const ETA_BY_REGIME: Record<HMMRegime, number> = {
  Accumulation: 0.30,
  Trending: 0.50,
  Mania: 0.10,
  Distribution: 0.15,
};

const MIN_FRACTION = 0.01;  // Never bet less than 1%
const MAX_FRACTION = 0.25;  // Never bet more than 25%
const MIN_CONFIDENCE = 0.4; // Skip trade if AIBrain confidence < 40%

export class KellyEngine {
  private bankrollSol: number;
  private stats = {
    computations: 0,
    skipped: 0,
    avgFraction: 0,
  };

  constructor(initialBankrollSol: number = 1.0) {
    this.bankrollSol = initialBankrollSol;
    console.log(`💰 [KellyEngine] Initialized (bankroll=${initialBankrollSol} SOL)`);
  }

  /**
   * Compute optimal position size.
   *
   * @param winProb - Probability of winning the trade (from AIBrain)
   * @param odds - Expected win/loss ratio (e.g. 2.0 = win 2x what you risk)
   * @param regime - Current HMM regime
   * @param confidence - AIBrain confidence (0-1)
   * @param cvarMultiplier - CVaR risk adjustment (0.5-1.0, lower = more risk averse)
   */
  compute(
    winProb: number,
    odds: number,
    regime: HMMRegime,
    confidence: number,
    cvarMultiplier: number = 1.0,
  ): PositionSizing {
    this.stats.computations++;

    const eta = ETA_BY_REGIME[regime];
    const q = 1 - winProb;

    // Kelly formula: f* = η × (b×p - q) / b
    let rawKelly = (odds * winProb - q) / odds;
    rawKelly = Math.max(0, rawKelly); // Never negative

    // Apply regime fraction
    let fraction = eta * rawKelly;

    // Apply CVaR adjustment
    fraction *= cvarMultiplier;

    // Apply confidence scaling — low confidence reduces position
    if (confidence < MIN_CONFIDENCE) {
      this.stats.skipped++;
      fraction = 0;
    } else {
      fraction *= confidence;
    }

    // Clamp
    fraction = Math.max(fraction > 0 ? MIN_FRACTION : 0, Math.min(MAX_FRACTION, fraction));

    const positionSol = fraction * this.bankrollSol;

    // EMA stats
    if (fraction > 0) {
      this.stats.avgFraction = this.stats.avgFraction * 0.95 + fraction * 0.05;
    }

    return {
      kellyFraction: fraction,
      positionSol,
      regime,
      eta,
      winProb,
      odds,
      confidence,
      cvarAdjustment: cvarMultiplier,
    };
  }

  /**
   * Update bankroll after a trade result.
   */
  updateBankroll(pnlSol: number): void {
    this.bankrollSol = Math.max(0, this.bankrollSol + pnlSol);
  }

  setBankroll(sol: number): void {
    this.bankrollSol = sol;
  }

  getBankroll(): number {
    return this.bankrollSol;
  }

  getStats() {
    return { ...this.stats, bankrollSol: this.bankrollSol };
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _kelly: KellyEngine | null = null;

export function getKellyEngine(bankroll?: number): KellyEngine {
  if (!_kelly) {
    const sol = bankroll ?? parseFloat(process.env.PAPER_BANKROLL_SOL ?? '1.0');
    _kelly = new KellyEngine(sol);
  }
  return _kelly;
}
