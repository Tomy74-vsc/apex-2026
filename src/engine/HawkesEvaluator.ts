/**
 * HawkesEvaluator — APEX-2026 Phase 3 (P3.2)
 *
 * Bivariate Hawkes process for buy/sell intensity estimation.
 * Hot path: evaluate λ(t) with fixed params (< 100μs).
 * Cold path: parameter re-estimation every N minutes (Python).
 *
 * Ring buffer of 1024 events. Exponential kernel: e^(-β(t-s)).
 * Events older than 10 minutes are automatically evicted.
 *
 * Two channels: BUY events and SELL events, each with own parameters.
 */

import { getBufferPool } from '../bridge/buffer-pool.js';

export interface HawkesParams {
  mu: number;     // baseline intensity
  alpha: number;  // excitation strength (self-exciting)
  beta: number;   // decay rate (1/seconds)
  cross: number;  // cross-excitation from other channel
}

export interface HawkesIntensity {
  lambdaBuy: number;
  lambdaSell: number;
  imbalance: number; // (λ_buy - λ_sell) / (λ_buy + λ_sell) — [-1, 1]
  eventCount: number;
  computedAt: number;
}

const RING_SIZE = 1024;
const MAX_EVENT_AGE_MS = 10 * 60_000; // 10 minutes

export class HawkesEvaluator {
  private buyTimes: Float64Array;
  private sellTimes: Float64Array;
  private buyHead = 0;
  private sellHead = 0;
  private buyCount = 0;
  private sellCount = 0;

  private buyParams: HawkesParams;
  private sellParams: HawkesParams;

  private stats = {
    eventsRecorded: 0,
    evaluations: 0,
  };

  constructor() {
    // Pre-allocate ring buffers (anti-GC)
    this.buyTimes = new Float64Array(RING_SIZE);
    this.sellTimes = new Float64Array(RING_SIZE);

    // Default parameters (will be overwritten by Python calibration)
    this.buyParams = { mu: 0.1, alpha: 0.5, beta: 1.0, cross: 0.2 };
    this.sellParams = { mu: 0.08, alpha: 0.4, beta: 0.8, cross: 0.15 };

    console.log('📈 [HawkesEvaluator] Initialized (ring=1024, window=10min)');
  }

  /**
   * Record a new trade event.
   */
  recordEvent(direction: 'BUY' | 'SELL', timestamp: number = Date.now()): void {
    this.stats.eventsRecorded++;

    if (direction === 'BUY') {
      this.buyTimes[this.buyHead % RING_SIZE] = timestamp;
      this.buyHead++;
      this.buyCount = Math.min(this.buyCount + 1, RING_SIZE);
    } else {
      this.sellTimes[this.sellHead % RING_SIZE] = timestamp;
      this.sellHead++;
      this.sellCount = Math.min(this.sellCount + 1, RING_SIZE);
    }
  }

  /**
   * Evaluate current intensities λ_buy(t) and λ_sell(t).
   * Hot path: < 100μs target.
   */
  evaluate(now: number = Date.now()): HawkesIntensity {
    this.stats.evaluations++;

    const lambdaBuy = this.evalChannel(
      this.buyTimes, this.buyHead, this.buyCount, this.buyParams,
      this.sellTimes, this.sellHead, this.sellCount, this.buyParams.cross,
      now,
    );

    const lambdaSell = this.evalChannel(
      this.sellTimes, this.sellHead, this.sellCount, this.sellParams,
      this.buyTimes, this.buyHead, this.buyCount, this.sellParams.cross,
      now,
    );

    const total = lambdaBuy + lambdaSell;
    const imbalance = total > 0 ? (lambdaBuy - lambdaSell) / total : 0;

    return {
      lambdaBuy,
      lambdaSell,
      imbalance,
      eventCount: this.buyCount + this.sellCount,
      computedAt: now,
    };
  }

  /**
   * Evaluate a single channel's intensity.
   * λ(t) = μ + α × Σ exp(-β(t-s)) + cross × Σ exp(-β(t-s'))
   */
  private evalChannel(
    selfTimes: Float64Array, selfHead: number, selfCount: number, params: HawkesParams,
    crossTimes: Float64Array, crossHead: number, crossCount: number, crossAlpha: number,
    now: number,
  ): number {
    let lambda = params.mu;

    // Self-excitation
    const selfStart = Math.max(0, selfHead - selfCount);
    for (let i = selfStart; i < selfHead; i++) {
      const t = selfTimes[i % RING_SIZE]!;
      const dtMs = now - t;
      if (dtMs <= 0 || dtMs > MAX_EVENT_AGE_MS) continue;
      const dtSec = dtMs / 1000;
      lambda += params.alpha * Math.exp(-params.beta * dtSec);
    }

    // Cross-excitation
    const crossStart = Math.max(0, crossHead - crossCount);
    for (let i = crossStart; i < crossHead; i++) {
      const t = crossTimes[i % RING_SIZE]!;
      const dtMs = now - t;
      if (dtMs <= 0 || dtMs > MAX_EVENT_AGE_MS) continue;
      const dtSec = dtMs / 1000;
      lambda += crossAlpha * Math.exp(-params.beta * dtSec);
    }

    return Math.max(0, lambda);
  }

  /**
   * Quick λ_buy and λ_sell lookup. Hot path safe — returns tuple.
   */
  getIntensities(now: number = Date.now()): [number, number] {
    const result = this.evaluate(now);
    return [result.lambdaBuy, result.lambdaSell];
  }

  /**
   * Load calibrated parameters from Python (cold path).
   */
  loadParams(buyParams: HawkesParams, sellParams: HawkesParams): void {
    this.buyParams = { ...buyParams };
    this.sellParams = { ...sellParams };
    console.log(
      `📈 [HawkesEvaluator] Params updated: buy(μ=${buyParams.mu}, α=${buyParams.alpha}, β=${buyParams.beta}) ` +
        `sell(μ=${sellParams.mu}, α=${sellParams.alpha}, β=${sellParams.beta})`,
    );
  }

  getStats() {
    return {
      ...this.stats,
      buyCount: this.buyCount,
      sellCount: this.sellCount,
    };
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _hawkes: HawkesEvaluator | null = null;

export function getHawkesEvaluator(): HawkesEvaluator {
  if (!_hawkes) {
    _hawkes = new HawkesEvaluator();
  }
  return _hawkes;
}
