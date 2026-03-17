/**
 * FallbackBridge — Pure TypeScript implementation when Rust .dll/.so is unavailable.
 *
 * Provides the same IApexBridge interface with JS-only math.
 * Performance: ~10-100x slower than Rust FFI, but functional.
 * Used for development, testing, and as automatic fallback.
 */

import type { IApexBridge } from './types.js';
import { HMM_STATES, HMM_REGIMES } from './types.js';
import { getBufferPool } from './buffer-pool.js';

export class FallbackBridge implements IApexBridge {
  readonly isNative = false;
  readonly name = 'FallbackBridge (pure-TS)';

  private hmmTransition: Float64Array;
  private hmmStatePriors: Float64Array;
  private hmmMeans: Float64Array;
  private hmmVariances: Float64Array;

  constructor() {
    // Default HMM parameters (will be overwritten by trained params)
    this.hmmTransition = new Float64Array([
      0.90, 0.05, 0.03, 0.02,
      0.05, 0.85, 0.07, 0.03,
      0.02, 0.08, 0.80, 0.10,
      0.03, 0.02, 0.10, 0.85,
    ]);
    this.hmmStatePriors = new Float64Array([0.25, 0.25, 0.25, 0.25]);
    this.hmmMeans = new Float64Array([0.001, 0.005, 0.02, -0.003]);
    this.hmmVariances = new Float64Array([0.0001, 0.0004, 0.002, 0.0003]);

    console.log('⚠️  [FallbackBridge] Running in pure-TS mode (no Rust FFI)');
  }

  ping(): number {
    return performance.now() * 1000; // μs
  }

  version(): number {
    return 100; // v0.1.0
  }

  bench(iterations: number): number {
    const start = performance.now();
    let acc = 1.0;
    for (let i = 0; i < iterations; i++) {
      acc *= 1.0 + i * 0.000001;
    }
    // Prevent dead-code elimination
    if (acc === Infinity) console.log(acc);
    return (performance.now() - start) * 1000; // μs
  }

  benchBuffer(input: Float64Array, output: Float64Array): number {
    const start = performance.now();
    for (let i = 0; i < input.length; i++) {
      output[i] = input[i]! * 2.0;
    }
    return (performance.now() - start) * 1000; // μs
  }

  /**
   * Hamilton filter — simplified pure-TS implementation.
   * Returns P(state_j | observations) as Float64Array[4].
   */
  inferHMM(logReturn: number, _realizedVol: number, _ofi: number): Float64Array {
    const pool = getBufferPool();
    const result = pool.acquire(HMM_STATES);

    // Gaussian emission likelihood per state
    const likelihoods = new Array<number>(HMM_STATES);
    for (let j = 0; j < HMM_STATES; j++) {
      const mu = this.hmmMeans[j]!;
      const sigma2 = this.hmmVariances[j]!;
      const diff = logReturn - mu;
      likelihoods[j] = Math.exp(-0.5 * (diff * diff) / sigma2) / Math.sqrt(2 * Math.PI * sigma2);
    }

    // Prediction step: P(s_t | s_{t-1}) × P(s_{t-1} | y_{1:t-1})
    const predicted = new Array<number>(HMM_STATES).fill(0);
    for (let j = 0; j < HMM_STATES; j++) {
      for (let i = 0; i < HMM_STATES; i++) {
        predicted[j]! += this.hmmTransition[i * HMM_STATES + j]! * this.hmmStatePriors[i]!;
      }
    }

    // Update step: P(s_t | y_{1:t}) ∝ P(y_t | s_t) × P(s_t | y_{1:t-1})
    let total = 0;
    for (let j = 0; j < HMM_STATES; j++) {
      result[j] = likelihoods[j]! * predicted[j]!;
      total += result[j]!;
    }

    // Normalize
    if (total > 0) {
      for (let j = 0; j < HMM_STATES; j++) {
        result[j] = result[j]! / total;
      }
    } else {
      result.fill(1.0 / HMM_STATES);
    }

    // Update priors for next call
    this.hmmStatePriors.set(result);

    return result;
  }

  /**
   * Hawkes intensity — simplified exponential kernel evaluation.
   * events: timestamps of past events (unix ms).
   * Returns [λ_buy, λ_sell] as tuple.
   */
  evalHawkesIntensity(events: Float64Array, now: number): [number, number] {
    const mu = 0.1;
    const alpha = 0.5;
    const beta = 1.0;

    let intensity = mu;
    for (let i = 0; i < events.length; i++) {
      const dt = (now - events[i]!) / 1000; // seconds
      if (dt > 0 && dt < 600) {
        intensity += alpha * Math.exp(-beta * dt);
      }
    }

    // Split into buy/sell (simplified: 60/40 ratio based on last events)
    return [intensity * 0.6, intensity * 0.4];
  }

  /**
   * TFT inference stub — returns flat prediction until ONNX model is loaded.
   */
  inferTFT(_featureSequence: Float64Array, _seqLen: number): Float64Array {
    const pool = getBufferPool();
    const result = pool.acquire(2);
    result[0] = 0.0; // price_change_5m prediction
    result[1] = 0.0; // price_change_30m prediction
    return result;
  }

  dispose(): void {
    console.log('✅ [FallbackBridge] Disposed');
  }
}
