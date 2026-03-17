/**
 * FFI Type Definitions — Shared between RustBridge and fallback.
 *
 * These types mirror rust_core/src/types.rs exactly.
 * Any change here MUST be reflected in the Rust side.
 */

export const FEATURE_COUNT = 12;
export const HMM_STATES = 4;
export const TFT_SEQ_LEN = 128;

/**
 * Feature vector layout (order matters — must match Rust FeatureVector).
 * Total: 12 × f64 = 96 bytes.
 */
export enum FeatureIndex {
  OFI = 0,
  HAWKES_BUY = 1,
  HAWKES_SELL = 2,
  HMM_STATE0 = 3, // P(Accumulation)
  HMM_STATE1 = 4, // P(Trending)
  HMM_STATE2 = 5, // P(Mania)
  HMM_STATE3 = 6, // P(Distribution)
  NLP_SCORE = 7,
  SMART_MONEY = 8,
  REALIZED_VOL = 9,
  LIQUIDITY_SOL = 10,
  PRICE_USDC = 11,
}

/** HMM regime names mapped to state index */
export const HMM_REGIMES = [
  'Accumulation',
  'Trending',
  'Mania',
  'Distribution',
] as const;
export type HMMRegime = (typeof HMM_REGIMES)[number];

/** Inference result from the Rust engine */
export interface InferenceResult {
  signal: number;     // -1.0 (sell) to 1.0 (buy)
  confidence: number; // 0.0 to 1.0
  regime: HMMRegime;
  regimeIndex: number;
  error: string | null;
}

/** Bridge interface — implemented by RustBridge (FFI) and FallbackBridge (pure TS) */
export interface IApexBridge {
  readonly isNative: boolean;
  readonly name: string;

  // Hot path — synchronous, < 100μs target
  ping(): number;
  version(): number;
  bench(iterations: number): number;
  benchBuffer(input: Float64Array, output: Float64Array): number;

  // HMM filter (Phase 3)
  inferHMM(logReturn: number, realizedVol: number, ofi: number): Float64Array;

  // Hawkes intensity (Phase 3)
  evalHawkesIntensity(events: Float64Array, now: number): [number, number];

  // TFT inference (Phase 3)
  inferTFT(featureSequence: Float64Array, seqLen: number): Float64Array;

  // Lifecycle
  dispose(): void;
}
