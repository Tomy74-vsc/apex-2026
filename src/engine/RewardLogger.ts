/**
 * RewardLogger — APEX-2026 Phase 4 (P4.4.1)
 *
 * Computes and logs the Reward Function R_i for each trade.
 * This dataset is the foundation for PPO RL training (Phase 5).
 *
 * Formula:
 *   R_i = [log(1 + r_i) - λ_c × C_i - λ_r × CVaR_α(D) - λ_f × 1[fail]] / Growth
 *
 * Where:
 *   r_i   = trade return
 *   C_i   = slippage + fees (as fraction)
 *   CVaR  = tail risk penalty
 *   fail  = 1 if transaction failed
 *   Growth = normalizing factor (bankroll growth)
 */

import { getFeatureStore } from '../data/FeatureStore.js';

export interface RewardRecord {
  id: string;
  mint: string;
  featureSnapshotId: string;
  tradeReturn: number;       // r_i (log return)
  slippage: number;           // actual vs expected price
  fees: number;               // network + Jito tip in SOL
  cvarPenalty: number;        // λ_r × CVaR at time of trade
  failed: boolean;            // transaction failed
  reward: number;             // R_i computed
  regime: string;             // HMM regime at decision time
  kellyFraction: number;      // f* used
  positionSol: number;        // actual position size
  timestamp: number;
}

// Penalty weights
const LAMBDA_COST = 2.0;     // slippage + fees penalty
const LAMBDA_RISK = 1.0;     // CVaR penalty
const LAMBDA_FAIL = 5.0;     // transaction failure penalty

export class RewardLogger {
  private records: RewardRecord[] = [];
  private maxRecords = 10_000;
  private stats = {
    logged: 0,
    avgReward: 0,
    positiveRewards: 0,
  };

  constructor() {
    console.log('🎯 [RewardLogger] Initialized (λ_c=2.0, λ_r=1.0, λ_f=5.0)');
  }

  /**
   * Compute and log R_i for a completed trade.
   */
  log(params: {
    mint: string;
    featureSnapshotId: string;
    tradeReturn: number;
    slippage: number;
    feesSol: number;
    cvarAtDecision: number;
    failed: boolean;
    regime: string;
    kellyFraction: number;
    positionSol: number;
    bankrollGrowth?: number;
  }): RewardRecord {
    const {
      mint, featureSnapshotId, tradeReturn, slippage, feesSol,
      cvarAtDecision, failed, regime, kellyFraction, positionSol,
    } = params;

    const growth = Math.max(0.01, params.bankrollGrowth ?? 1.0);

    // R_i = [log(1 + r_i) - λ_c × C_i - λ_r × |CVaR| - λ_f × 1[fail]] / Growth
    const costPenalty = LAMBDA_COST * (Math.abs(slippage) + feesSol / Math.max(positionSol, 0.001));
    const riskPenalty = LAMBDA_RISK * Math.abs(cvarAtDecision);
    const failPenalty = failed ? LAMBDA_FAIL : 0;

    const reward = (Math.log(1 + tradeReturn) - costPenalty - riskPenalty - failPenalty) / growth;

    const record: RewardRecord = {
      id: crypto.randomUUID(),
      mint,
      featureSnapshotId,
      tradeReturn,
      slippage,
      fees: feesSol,
      cvarPenalty: riskPenalty,
      failed,
      reward,
      regime,
      kellyFraction,
      positionSol,
      timestamp: Date.now(),
    };

    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }

    this.stats.logged++;
    this.stats.avgReward = this.stats.avgReward * 0.95 + reward * 0.05;
    if (reward > 0) this.stats.positiveRewards++;

    const emoji = reward > 0.1 ? '🚀' : reward > 0 ? '✅' : reward > -0.1 ? '⚠️' : '❌';
    console.log(
      `${emoji} [RewardLogger] ${mint.slice(0, 8)} | R=${reward.toFixed(4)} | ` +
        `ret=${(tradeReturn * 100).toFixed(1)}% | cost=${costPenalty.toFixed(4)} | ` +
        `risk=${riskPenalty.toFixed(4)} | fail=${failed ? 'YES' : 'no'} | regime=${regime}`,
    );

    return record;
  }

  /**
   * Get recent reward records for RL training.
   */
  getRecords(limit?: number): RewardRecord[] {
    if (!limit) return [...this.records];
    return this.records.slice(-limit);
  }

  /**
   * Compute aggregate metrics for the reward distribution.
   */
  getMetrics(): {
    count: number;
    avgReward: number;
    stdReward: number;
    positiveRate: number;
    totalReturn: number;
  } {
    const n = this.records.length;
    if (n === 0) {
      return { count: 0, avgReward: 0, stdReward: 0, positiveRate: 0, totalReturn: 0 };
    }

    const rewards = this.records.map((r) => r.reward);
    const mean = rewards.reduce((s, r) => s + r, 0) / n;
    const variance = rewards.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
    const positives = rewards.filter((r) => r > 0).length;
    const totalReturn = this.records.reduce((s, r) => s + r.tradeReturn, 0);

    return {
      count: n,
      avgReward: mean,
      stdReward: Math.sqrt(variance),
      positiveRate: positives / n,
      totalReturn,
    };
  }

  getStats() {
    return { ...this.stats, totalRecords: this.records.length };
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _logger: RewardLogger | null = null;

export function getRewardLogger(): RewardLogger {
  if (!_logger) {
    _logger = new RewardLogger();
  }
  return _logger;
}
