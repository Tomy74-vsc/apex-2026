/**
 * ShadowAgent — APEX-2026 Phase 5 (P5.2.1)
 *
 * Runs the RL agent in parallel with the live V3 system.
 * Receives the same features as AIBrain, makes its own prediction,
 * but NEVER executes trades. Logs decisions for offline comparison.
 *
 * Metrics tracked:
 *   - Shadow Sharpe vs Live Sharpe
 *   - Shadow win rate vs Live win rate
 *   - Shadow max drawdown
 *   - Agreement rate (shadow == live decision)
 *
 * When shadow outperforms live on 1000+ trades → eligible for promotion.
 */

import { EventEmitter } from 'events';
import { getFeatureStore } from '../data/FeatureStore.js';
import type { AIDecision } from './AIBrain.js';
import type { AssembledFeatures } from '../features/FeatureAssembler.js';

export interface ShadowDecision {
  mint: string;
  action: 'BUY' | 'SKIP' | 'SELL';
  actionIndex: number;
  confidence: number;
  liveAction: 'BUY' | 'SKIP';
  agreed: boolean;
  timestamp: number;
}

export interface ShadowMetrics {
  totalDecisions: number;
  buys: number;
  skips: number;
  sells: number;
  agreementRate: number;
  shadowReturns: number[];
  liveReturns: number[];
  shadowSharpe: number;
  liveSharpe: number;
  shadowWinRate: number;
  liveWinRate: number;
  shadowMaxDrawdown: number;
  promotionEligible: boolean;
}

const PROMOTION_MIN_TRADES = 1000;
const PROMOTION_SHARPE_MARGIN = 1.05; // Shadow must be 5% better

export class ShadowAgent extends EventEmitter {
  private decisions: ShadowDecision[] = [];
  private shadowReturns: number[] = [];
  private liveReturns: number[] = [];
  private maxDecisions = 50_000;
  private enabled = true;

  private stats = {
    totalDecisions: 0,
    agreements: 0,
    shadowBuys: 0,
    liveBuys: 0,
  };

  constructor() {
    super();
    console.log('👻 [ShadowAgent] Initialized (shadow mode — no live execution)');
  }

  /**
   * Shadow-evaluate a trading decision using the RL policy.
   * Called in parallel with AIBrain.decide() — non-blocking.
   *
   * For now uses a simple heuristic policy as placeholder.
   * When ONNX model is available, loads via bridge.inferTFT() or dedicated loader.
   */
  evaluate(
    mint: string,
    features: AssembledFeatures,
    liveDecision: AIDecision,
  ): ShadowDecision {
    if (!this.enabled) {
      return this.defaultDecision(mint, liveDecision);
    }

    const t0 = performance.now();
    this.stats.totalDecisions++;

    // Shadow policy — placeholder until ONNX PPO model is loaded
    // Uses a simple rule: if aiScore > 65 and regime is Trending/Accumulation → BUY
    const shadowAction = this.shadowPolicy(features, liveDecision);
    const agreed = shadowAction === liveDecision.action;
    if (agreed) this.stats.agreements++;
    if (shadowAction === 'BUY') this.stats.shadowBuys++;
    if (liveDecision.action === 'BUY') this.stats.liveBuys++;

    const decision: ShadowDecision = {
      mint,
      action: shadowAction,
      actionIndex: shadowAction === 'BUY' ? 0 : shadowAction === 'SKIP' ? 1 : 2,
      confidence: liveDecision.confidence,
      liveAction: liveDecision.action,
      agreed,
      timestamp: Date.now(),
    };

    this.decisions.push(decision);
    if (this.decisions.length > this.maxDecisions) {
      this.decisions.shift();
    }

    const latencyMs = performance.now() - t0;
    const emoji = agreed ? '🤝' : '⚔️';
    console.log(
      `${emoji} [Shadow] ${mint.slice(0, 8)} | shadow=${shadowAction} live=${liveDecision.action} | ` +
        `agree=${this.getAgreementRate().toFixed(1)}% | ${latencyMs.toFixed(2)}ms`,
    );

    this.emit('shadowDecision', decision);
    return decision;
  }

  /**
   * Record actual price outcome for both shadow and live decisions.
   */
  recordOutcome(
    mint: string,
    priceChange5m: number,
    shadowAction: 'BUY' | 'SKIP' | 'SELL',
    liveAction: 'BUY' | 'SKIP',
  ): void {
    const shadowReturn = shadowAction === 'BUY'
      ? priceChange5m
      : shadowAction === 'SELL'
        ? -priceChange5m
        : 0;

    const liveReturn = liveAction === 'BUY' ? priceChange5m : 0;

    this.shadowReturns.push(shadowReturn);
    this.liveReturns.push(liveReturn);

    if (this.shadowReturns.length > this.maxDecisions) {
      this.shadowReturns.shift();
      this.liveReturns.shift();
    }
  }

  /**
   * Placeholder shadow policy. Replaced by ONNX PPO model when available.
   */
  private shadowPolicy(
    features: AssembledFeatures,
    liveDecision: AIDecision,
  ): 'BUY' | 'SKIP' | 'SELL' {
    // More aggressive than live: lower threshold, uses Hawkes imbalance
    if (
      liveDecision.aiScore >= 55 &&
      liveDecision.confidence >= 0.30 &&
      liveDecision.hawkesImbalance > -0.3 &&
      liveDecision.regime !== 'Mania' &&
      liveDecision.regime !== 'Distribution'
    ) {
      return 'BUY';
    }

    // Shadow can also SELL (short signal) — live system cannot
    if (
      liveDecision.regime === 'Distribution' &&
      liveDecision.hawkesImbalance < -0.5
    ) {
      return 'SELL';
    }

    return 'SKIP';
  }

  private defaultDecision(mint: string, live: AIDecision): ShadowDecision {
    return {
      mint,
      action: 'SKIP',
      actionIndex: 1,
      confidence: 0,
      liveAction: live.action,
      agreed: live.action === 'SKIP',
      timestamp: Date.now(),
    };
  }

  getAgreementRate(): number {
    if (this.stats.totalDecisions === 0) return 100;
    return (this.stats.agreements / this.stats.totalDecisions) * 100;
  }

  getMetrics(): ShadowMetrics {
    const shadowSharpe = this.computeSharpe(this.shadowReturns);
    const liveSharpe = this.computeSharpe(this.liveReturns);
    const shadowWinRate = this.computeWinRate(this.shadowReturns);
    const liveWinRate = this.computeWinRate(this.liveReturns);
    const shadowMaxDrawdown = this.computeMaxDrawdown(this.shadowReturns);

    const promotionEligible =
      this.shadowReturns.length >= PROMOTION_MIN_TRADES &&
      shadowSharpe > liveSharpe * PROMOTION_SHARPE_MARGIN;

    return {
      totalDecisions: this.stats.totalDecisions,
      buys: this.stats.shadowBuys,
      skips: this.stats.totalDecisions - this.stats.shadowBuys,
      sells: 0,
      agreementRate: this.getAgreementRate(),
      shadowReturns: this.shadowReturns.slice(-100),
      liveReturns: this.liveReturns.slice(-100),
      shadowSharpe,
      liveSharpe,
      shadowWinRate,
      liveWinRate,
      shadowMaxDrawdown,
      promotionEligible,
    };
  }

  private computeSharpe(returns: number[]): number {
    if (returns.length < 5) return 0;
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    if (std < 1e-8) return 0;
    return (mean / std) * Math.sqrt(252 * 24 * 12); // annualized (5min bars)
  }

  private computeWinRate(returns: number[]): number {
    if (returns.length === 0) return 0.5;
    const wins = returns.filter((r) => r > 0).length;
    return wins / returns.length;
  }

  private computeMaxDrawdown(returns: number[]): number {
    if (returns.length === 0) return 0;
    let peak = 1;
    let equity = 1;
    let maxDD = 0;
    for (const r of returns) {
      equity *= 1 + r;
      if (equity > peak) peak = equity;
      const dd = (equity - peak) / peak;
      if (dd < maxDD) maxDD = dd;
    }
    return maxDD;
  }

  getStats() {
    return {
      ...this.stats,
      agreementRate: this.getAgreementRate(),
      shadowTradesLogged: this.shadowReturns.length,
    };
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _shadow: ShadowAgent | null = null;

export function getShadowAgent(): ShadowAgent {
  if (!_shadow) {
    _shadow = new ShadowAgent();
  }
  return _shadow;
}
