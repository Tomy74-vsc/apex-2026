/**
 * FeatureAssembler — APEX-2026 Phase 2 (P2.4.1)
 *
 * Assembles all feature sources into a normalized 12-dimensional vector
 * ready for inference (HMM, Hawkes, TFT via FFI).
 *
 * Each feature carries a timestamp for staleness tracking.
 * The model receives (value, age_ms) implicitly via maxStalenessMs.
 *
 * Feature layout (matches FeatureIndex in bridge/types.ts):
 *   [0]  OFI            — Order Flow Imbalance [-1, 1]
 *   [1]  hawkesBuy      — Hawkes λ_buy intensity
 *   [2]  hawkesSell     — Hawkes λ_sell intensity
 *   [3]  hmmState0      — P(Accumulation)
 *   [4]  hmmState1      — P(Trending)
 *   [5]  hmmState2      — P(Mania)
 *   [6]  hmmState3      — P(Distribution)
 *   [7]  nlpScore       — NLP sentiment [-1, 1]
 *   [8]  smartMoney     — Smart Money S_SM(t)
 *   [9]  realizedVol    — Realized volatility
 *   [10] liquiditySol   — Pool liquidity in SOL
 *   [11] priceUsdc      — Current price in USDC
 */

import { getBufferPool, FEATURE_VECTOR_SIZE } from '../bridge/buffer-pool.js';
import { FeatureIndex } from '../bridge/types.js';
import { getOFICalculator } from './OFICalculator.js';
import { getBridge } from '../bridge/RustBridge.js';
import { getViralityScorer } from '../nlp/ViralityScorer.js';
import { getSmartMoneyTracker } from '../ingestors/SmartMoneyTracker.js';
import type { FeatureSnapshotRecord } from '../types/index.js';

export interface AssembledFeatures {
  values: Float64Array;     // 12 features (from BufferPool — no GC)
  timestamps: number[];     // Unix ms per feature source
  maxStalenessMs: number;   // age of the oldest feature
  mint: string;
  assembledAt: number;
}

interface FeatureSource {
  value: number;
  timestamp: number;
}

export class FeatureAssembler {
  private priceCache: Map<string, { price: number; vol: number; t: number }> = new Map();
  private stats = {
    assembled: 0,
    avgStalenessMs: 0,
  };

  constructor() {
    console.log('🔧 [FeatureAssembler] Initialized (12-dim feature vector)');
  }

  /**
   * Assemble a full feature vector for a given mint.
   * Pulls from all feature sources (OFI, NLP, SmartMoney, Bridge/HMM/Hawkes).
   *
   * @param mint - Token mint address
   * @param liquiditySol - Current pool liquidity
   * @param priceUsdc - Current price
   * @param nlpSentiment - Latest NLP sentiment (-1 to 1)
   */
  assemble(
    mint: string,
    liquiditySol: number,
    priceUsdc: number,
    nlpSentiment: number = 0,
  ): AssembledFeatures {
    const now = Date.now();
    const pool = getBufferPool();
    const values = pool.acquire(FEATURE_VECTOR_SIZE);
    const timestamps: number[] = new Array(FEATURE_VECTOR_SIZE).fill(now);

    // ─── Feature 0: OFI ──────────────────────────────────────────────
    const ofi = getOFICalculator().getOFI(mint);
    values[FeatureIndex.OFI] = ofi;

    // ─── Features 1-2: Hawkes intensity (from bridge) ────────────────
    // These will be populated by AIBrain in Phase 3
    // For now, use 0 (neutral)
    values[FeatureIndex.HAWKES_BUY] = 0;
    values[FeatureIndex.HAWKES_SELL] = 0;

    // ─── Features 3-6: HMM state probabilities (from bridge) ────────
    // Will be populated by AIBrain in Phase 3
    // Default: uniform distribution
    const bridge = getBridge();
    const logReturn = this.computeLogReturn(mint, priceUsdc);
    const hmmProbs = bridge.inferHMM(logReturn, 0, ofi);
    values[FeatureIndex.HMM_STATE0] = hmmProbs[0]!;
    values[FeatureIndex.HMM_STATE1] = hmmProbs[1]!;
    values[FeatureIndex.HMM_STATE2] = hmmProbs[2]!;
    values[FeatureIndex.HMM_STATE3] = hmmProbs[3]!;

    // ─── Feature 7: NLP sentiment ────────────────────────────────────
    values[FeatureIndex.NLP_SCORE] = nlpSentiment;

    // ─── Feature 8: Smart Money ──────────────────────────────────────
    values[FeatureIndex.SMART_MONEY] = getSmartMoneyTracker().getScore(mint);

    // ─── Feature 9: Realized volatility ──────────────────────────────
    values[FeatureIndex.REALIZED_VOL] = this.computeRealizedVol(mint, priceUsdc);

    // ─── Feature 10: Liquidity ───────────────────────────────────────
    values[FeatureIndex.LIQUIDITY_SOL] = this.normalizeLiquidity(liquiditySol);

    // ─── Feature 11: Price ───────────────────────────────────────────
    values[FeatureIndex.PRICE_USDC] = priceUsdc;

    // Staleness
    const minTimestamp = Math.min(...timestamps);
    const maxStalenessMs = now - minTimestamp;

    this.stats.assembled++;
    this.stats.avgStalenessMs =
      this.stats.avgStalenessMs * 0.95 + maxStalenessMs * 0.05; // EMA

    return {
      values,
      timestamps,
      maxStalenessMs,
      mint,
      assembledAt: now,
    };
  }

  /**
   * Convert assembled features to a FeatureSnapshotRecord for persistence.
   */
  toSnapshot(features: AssembledFeatures, source: FeatureSnapshotRecord['source']): FeatureSnapshotRecord {
    const v = features.values;
    return {
      id: crypto.randomUUID(),
      mint: features.mint,
      timestampMs: features.assembledAt,
      ofi: v[FeatureIndex.OFI]!,
      hawkesBuy: v[FeatureIndex.HAWKES_BUY]!,
      hawkesSell: v[FeatureIndex.HAWKES_SELL]!,
      hmmState0: v[FeatureIndex.HMM_STATE0]!,
      hmmState1: v[FeatureIndex.HMM_STATE1]!,
      hmmState2: v[FeatureIndex.HMM_STATE2]!,
      hmmState3: v[FeatureIndex.HMM_STATE3]!,
      nlpScore: v[FeatureIndex.NLP_SCORE]!,
      smartMoney: v[FeatureIndex.SMART_MONEY]!,
      realizedVol: v[FeatureIndex.REALIZED_VOL]!,
      liquiditySol: v[FeatureIndex.LIQUIDITY_SOL]!,
      priceUsdc: v[FeatureIndex.PRICE_USDC]!,
      maxStalenessMs: features.maxStalenessMs,
      source,
      latencyMs: 0,
      createdAt: Date.now(),
    };
  }

  /**
   * Compute log return from cached price history.
   */
  private computeLogReturn(mint: string, currentPrice: number): number {
    const cached = this.priceCache.get(mint);
    if (!cached || cached.price <= 0 || currentPrice <= 0) {
      this.updatePriceCache(mint, currentPrice);
      return 0;
    }
    const logRet = Math.log(currentPrice / cached.price);
    this.updatePriceCache(mint, currentPrice);
    return logRet;
  }

  /**
   * Compute realized volatility from price history (simplified).
   * Uses exponential weighted moving variance.
   */
  private computeRealizedVol(mint: string, currentPrice: number): number {
    const cached = this.priceCache.get(mint);
    if (!cached || cached.price <= 0 || currentPrice <= 0) return 0;

    const logRet = Math.log(currentPrice / cached.price);
    // EWMA variance: σ² = λ × σ²_prev + (1-λ) × r²
    const lambda = 0.94;
    const newVol = Math.sqrt(lambda * (cached.vol * cached.vol) + (1 - lambda) * logRet * logRet);
    return newVol;
  }

  private updatePriceCache(mint: string, price: number): void {
    const existing = this.priceCache.get(mint);
    this.priceCache.set(mint, {
      price,
      vol: existing?.vol ?? 0,
      t: Date.now(),
    });

    // Evict old entries
    if (this.priceCache.size > 1000) {
      const oldest = this.priceCache.keys().next().value;
      if (oldest) this.priceCache.delete(oldest);
    }
  }

  /**
   * Normalize liquidity to [0, 1] range via log scaling.
   * 0 SOL → 0, 10 SOL → 0.5, 1000 SOL → 1.0
   */
  private normalizeLiquidity(sol: number): number {
    if (sol <= 0) return 0;
    return Math.min(1, Math.log10(sol + 1) / 3); // log10(1001) ≈ 3
  }

  getStats() {
    return { ...this.stats, priceCacheSize: this.priceCache.size };
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _assembler: FeatureAssembler | null = null;

export function getFeatureAssembler(): FeatureAssembler {
  if (!_assembler) {
    _assembler = new FeatureAssembler();
  }
  return _assembler;
}
