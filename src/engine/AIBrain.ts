/**
 * AIBrain — APEX-2026 Phase 3 (P3.4.1)
 *
 * Central inference orchestrator. Replaces the linear scoring heuristic
 * in DecisionCore with a multi-model pipeline.
 *
 * Hot path pipeline (budget: < 10ms total):
 *   1. HMM Hamilton filter   → regime + P(state) (< 10μs via bridge)
 *   2. Hawkes intensity       → λ_buy, λ_sell     (< 100μs)
 *   3. TFT prediction         → price forecast     (< 5ms via bridge/ONNX)
 *   4. Kelly sizing           → f* position size    (< 1μs)
 *   5. Decision               → BUY / SKIP          (< 1μs)
 *
 * Emits: 'decision' event with full AIDecision for downstream consumers.
 */

import { EventEmitter } from 'events';
import { getBridge } from '../bridge/RustBridge.js';
import { getBufferPool, FEATURE_VECTOR_SIZE } from '../bridge/buffer-pool.js';
import { FeatureIndex, HMM_REGIMES, type HMMRegime } from '../bridge/types.js';
import { getFeatureAssembler, type AssembledFeatures } from '../features/FeatureAssembler.js';
import { getHawkesEvaluator } from './HawkesEvaluator.js';
import { getKellyEngine, type PositionSizing } from '../risk/KellyEngine.js';
import { getCVaRManager, type RiskMetrics } from '../risk/CVaRManager.js';
import {
  getGraduationPredictor,
  type GraduationVetoStatsReport,
  type PredictionResult,
} from '../modules/graduation-predictor/GraduationPredictor.js';
import { calcExpectedReturnOnGraduation } from '../math/curve-math.js';
import type { TrackedCurve, CurveTradeEvent } from '../types/bonding-curve.js';

const LAMPORTS_PER_SOL_BIG = 1_000_000_000n;

export interface AIDecision {
  mint: string;
  action: 'BUY' | 'SKIP';

  // Model outputs
  regime: HMMRegime;
  regimeProbs: number[];        // [P(Acc), P(Trend), P(Mania), P(Dist)]
  hawkesBuyIntensity: number;
  hawkesSellIntensity: number;
  hawkesImbalance: number;      // [-1, 1]
  tftPrediction5m: number;      // predicted price change at T+5m
  tftPrediction30m: number;

  // Risk & sizing
  kelly: PositionSizing;
  riskMetrics: RiskMetrics;

  // Scoring
  aiScore: number;              // 0-100 composite score
  confidence: number;           // 0-1
  linearScore: number;          // legacy linear score for comparison

  // Latency
  latencyMs: number;
  breakdown: {
    hmmMs: number;
    hawkesMs: number;
    tftMs: number;
    kellyMs: number;
    totalMs: number;
  };
}

/**
 * CurveDecision — result of the curve-prediction pipeline.
 * Replaces HMM/Hawkes/TFT with GraduationPredictor.predict().
 */
export interface CurveDecision {
  mint: string;
  action: 'ENTER_CURVE' | 'EXIT_CURVE' | 'HOLD' | 'SKIP';
  pGrad: number;
  confidence: number;
  breakeven: number;
  prediction: PredictionResult;
  positionSol: number;
  latencyMs: number;
}

// Thresholds
const BUY_SCORE_THRESHOLD = 60;
const MIN_CONFIDENCE = 0.35;
const MAX_HAWKES_SELL_DOMINANCE = 3.0; // If λ_sell / λ_buy > 3, skip

// Score weights
const W_SECURITY = 0.25;      // From Guard security report
const W_REGIME = 0.20;        // HMM regime favorability
const W_HAWKES = 0.15;        // Order flow imbalance
const W_NLP = 0.15;           // Social sentiment
const W_TFT = 0.15;           // TFT price prediction
const W_SMART_MONEY = 0.10;   // Smart money signal

export class AIBrain extends EventEmitter {
  private stats = {
    decisions: 0,
    buys: 0,
    skips: 0,
    curveDecisions: 0,
    curveEnters: 0,
    avgLatencyMs: 0,
    avgScore: 0,
  };

  private readonly curveLoggedMints: Set<string> = new Set();

  constructor() {
    super();
    getGraduationPredictor();
    console.log('🧠 [AIBrain] Inference orchestrator initialized');
  }

  /**
   * Run the full inference pipeline on a feature vector.
   *
   * @param mint - Token mint
   * @param features - Pre-assembled feature vector (from FeatureAssembler)
   * @param securityScore - 0-100 from Guard (inverted risk score)
   * @param isFastCheck - Priority boost for high-liquidity tokens
   * @param linearScore - Legacy score from DecisionCore for comparison
   */
  decide(
    mint: string,
    features: AssembledFeatures,
    securityScore: number,
    isFastCheck: boolean = false,
    linearScore: number = 0,
  ): AIDecision {
    const t0 = performance.now();
    this.stats.decisions++;

    const v = features.values;
    const bridge = getBridge();

    // ─── Step 1: HMM Hamilton Filter (< 10μs) ───────────────────────
    const tHmm = performance.now();
    const hmmProbs = [
      v[FeatureIndex.HMM_STATE0]!,
      v[FeatureIndex.HMM_STATE1]!,
      v[FeatureIndex.HMM_STATE2]!,
      v[FeatureIndex.HMM_STATE3]!,
    ];
    const regimeIndex = hmmProbs.indexOf(Math.max(...hmmProbs));
    const regime = HMM_REGIMES[regimeIndex] ?? 'Accumulation';
    const hmmMs = performance.now() - tHmm;

    // ─── Step 2: Hawkes Intensity (< 100μs) ─────────────────────────
    const tHawkes = performance.now();
    const hawkes = getHawkesEvaluator().evaluate();
    const hawkesMs = performance.now() - tHawkes;

    // ─── Step 3: TFT Prediction (< 5ms via bridge/ONNX) ────────────
    const tTft = performance.now();
    const tftResult = bridge.inferTFT(new Float64Array(0), 0);
    const tftPred5m = tftResult[0] ?? 0;
    const tftPred30m = tftResult[1] ?? 0;
    const tftMs = performance.now() - tTft;

    // ─── Step 4: Composite AI Score ─────────────────────────────────
    // Security component (0-100 → 0-1)
    const securityComponent = securityScore / 100;

    // Regime component: Trending is most favorable, Mania least
    const regimeScores: Record<HMMRegime, number> = {
      Accumulation: 0.60,
      Trending: 0.90,
      Mania: 0.20,
      Distribution: 0.30,
    };
    const regimeComponent = regimeScores[regime];

    // Hawkes component: buy-dominant = positive
    const hawkesComponent = Math.max(0, Math.min(1, (hawkes.imbalance + 1) / 2));

    // NLP component: sentiment [-1,1] → [0,1]
    const nlpComponent = (v[FeatureIndex.NLP_SCORE]! + 1) / 2;

    // TFT component: predicted return → sigmoid
    const tftComponent = 1 / (1 + Math.exp(-tftPred5m * 100));

    // Smart money component: positive = bullish
    const smComponent = Math.max(0, Math.min(1, v[FeatureIndex.SMART_MONEY]! / 10 + 0.5));

    // Weighted composite
    const rawScore =
      W_SECURITY * securityComponent +
      W_REGIME * regimeComponent +
      W_HAWKES * hawkesComponent +
      W_NLP * nlpComponent +
      W_TFT * tftComponent +
      W_SMART_MONEY * smComponent;

    let aiScore = Math.round(rawScore * 100);

    // FastCheck bonus
    if (isFastCheck) aiScore = Math.min(100, aiScore + 5);

    // Confidence: product of regime probability × security / 100
    const confidence = hmmProbs[regimeIndex]! * securityComponent;

    // ─── Step 5: Kelly Sizing ────────────────────────────────────────
    const tKelly = performance.now();
    const riskMetrics = getCVaRManager().compute();
    const winProb = Math.max(0.1, Math.min(0.9, aiScore / 100));
    const odds = Math.max(1.0, 1.5 + tftPred5m * 10); // Dynamic odds from TFT
    const kelly = getKellyEngine().compute(
      winProb, odds, regime, confidence, riskMetrics.kellyMultiplier,
    );
    const kellyMs = performance.now() - tKelly;

    // ─── Step 6: Decision ────────────────────────────────────────────
    let action: 'BUY' | 'SKIP' = 'SKIP';

    // Kill switches
    const sellDominance = hawkes.lambdaBuy > 0
      ? hawkes.lambdaSell / hawkes.lambdaBuy
      : 0;

    if (
      aiScore >= BUY_SCORE_THRESHOLD &&
      confidence >= MIN_CONFIDENCE &&
      kelly.kellyFraction > 0 &&
      sellDominance < MAX_HAWKES_SELL_DOMINANCE &&
      regime !== 'Mania'
    ) {
      action = 'BUY';
      this.stats.buys++;
    } else {
      this.stats.skips++;
    }

    const totalMs = performance.now() - t0;
    this.stats.avgLatencyMs = this.stats.avgLatencyMs * 0.95 + totalMs * 0.05;
    this.stats.avgScore = this.stats.avgScore * 0.95 + aiScore * 0.05;

    const decision: AIDecision = {
      mint,
      action,
      regime,
      regimeProbs: hmmProbs,
      hawkesBuyIntensity: hawkes.lambdaBuy,
      hawkesSellIntensity: hawkes.lambdaSell,
      hawkesImbalance: hawkes.imbalance,
      tftPrediction5m: tftPred5m,
      tftPrediction30m: tftPred30m,
      kelly,
      riskMetrics,
      aiScore,
      confidence,
      linearScore,
      latencyMs: totalMs,
      breakdown: {
        hmmMs,
        hawkesMs,
        tftMs,
        kellyMs,
        totalMs,
      },
    };

    // Log
    const emoji = action === 'BUY' ? '🎯' : '⏭️';
    console.log(
      `${emoji} [AIBrain] ${mint.slice(0, 8)} | ${action} | score=${aiScore} | ` +
        `regime=${regime} | conf=${confidence.toFixed(2)} | kelly=${(kelly.kellyFraction * 100).toFixed(1)}% | ` +
        `hawkes=${hawkes.imbalance.toFixed(2)} | ${totalMs.toFixed(1)}ms`,
    );

    this.emit('decision', decision);
    return decision;
  }

  /**
   * Curve-prediction pipeline.
   * Calls GraduationPredictor instead of HMM/Hawkes/TFT.
   * Guard security kill switches are applied by DecisionCore before calling this.
   */
  decideCurve(
    curve: TrackedCurve,
    trades: CurveTradeEvent[],
    socialScore = 0,
    grokEnriched = false,
    fullAnalysis?: import('../types/index.js').FullCurveAnalysis | null,
  ): CurveDecision {
    const t0 = performance.now();
    this.stats.curveDecisions++;

    const prediction = getGraduationPredictor().predict(curve, trades, socialScore, grokEnriched, {
      fullAnalysis: fullAnalysis ?? undefined,
    });

    /** APEX §7 — multiplicateur sur f* (0.25 = quarter-Kelly). */
    const kellyEta = parseFloat(process.env.KELLY_FRACTION ?? '0.25');
    const maxPositionPct = parseFloat(process.env.MAX_POSITION_PCT ?? '0.05');
    const minPositionSol = parseFloat(process.env.MIN_POSITION_SOL ?? '0.05');
    const maxPositionSol = parseFloat(process.env.MAX_POSITION_SOL ?? '0.5');
    const bankroll = parseFloat(process.env.PAPER_BANKROLL_SOL ?? '1.0');
    const minKellyFrac = parseFloat(process.env.MIN_KELLY_FRACTION ?? '0.01');

    let positionSol = 0;
    let action: CurveDecision['action'] = prediction.action === 'ENTER_CURVE' ? 'ENTER_CURVE' : 'SKIP';

    if (action === 'ENTER_CURVE') {
      const realSolLamports = BigInt(Math.round(curve.realSolSOL * Number(LAMPORTS_PER_SOL_BIG)));
      const M = calcExpectedReturnOnGraduation(realSolLamports);
      const b = Math.max(0, M - 1);
      const p = prediction.pGrad;
      const q = 1 - p;
      const fStar = b > 1e-9 ? (b * p - q) / b : 0;
      const fApplied = Math.max(0, fStar * kellyEta);

      if (fApplied < minKellyFrac) {
        getGraduationPredictor().recordVetoStat('kelly_too_small');
        console.log(
          `📊 [Predictor] SKIP ${curve.mint.slice(0, 8)}… | Kelly f*=${fApplied.toFixed(4)} < min=${minKellyFrac}`,
        );
        action = 'SKIP';
      } else {
        const sized = Math.min(
          fApplied * bankroll,
          maxPositionSol,
          bankroll * maxPositionPct,
        );
        if (sized < minPositionSol) {
          action = 'SKIP';
        } else {
          positionSol = Math.max(minPositionSol, sized);
          this.stats.curveEnters++;
          getGraduationPredictor().noteCurveEnterFinal();
        }
      }
    }

    const latencyMs = performance.now() - t0;

    const decision: CurveDecision = {
      mint: curve.mint,
      action,
      pGrad: prediction.pGrad,
      confidence: prediction.confidence,
      breakeven: prediction.breakeven,
      prediction,
      positionSol,
      latencyMs,
    };

    const isFirst = !this.curveLoggedMints.has(curve.mint);
    if (isFirst) {
      this.curveLoggedMints.add(curve.mint);
      const emoji = action === 'ENTER_CURVE' ? '🎯' : '⏭️';
      console.log(
        `${emoji} [AIBrain:Curve] ${curve.mint.slice(0, 8)} | ${action} | ` +
        `pGrad=${(prediction.pGrad * 100).toFixed(1)}% | conf=${prediction.confidence.toFixed(2)} | ` +
        `pos=${positionSol.toFixed(3)} SOL | ${latencyMs.toFixed(1)}ms`,
      );
    }

    this.emit('curveDecision', decision);
    return decision;
  }

  /** Re-score pGrad for exit-engine time-stop (throttle in app.ts). */
  curvePredictionPGrad(
    curve: TrackedCurve,
    trades: CurveTradeEvent[],
    socialScore = 0,
    grokEnriched = false,
  ): number {
    return getGraduationPredictor().predict(curve, trades, socialScore, grokEnriched, {
      suppressEnterLog: true,
    }).pGrad;
  }

  /** GraduationPredictor only — no Kelly / decision stats. Used for HOT observation snapshots. */
  predictCurveOnly(
    curve: TrackedCurve,
    trades: CurveTradeEvent[],
    socialScore = 0,
    grokEnriched = false,
  ): PredictionResult {
    return getGraduationPredictor().predict(curve, trades, socialScore, grokEnriched, {
      suppressEnterLog: true,
    });
  }

  graduationVetoStats(): GraduationVetoStatsReport {
    return getGraduationPredictor().getVetoStats();
  }

  /** Forward to GraduationPredictor for creator outcome tracking. */
  recordCreatorOutcome(creator: string, graduated: boolean): void {
    getGraduationPredictor().recordCreatorOutcome(creator, graduated);
  }

  /** Forward to GraduationPredictor smart money list. */
  setSmartMoneyList(addresses: string[]): void {
    getGraduationPredictor().setSmartMoneyList(addresses);
  }

  getStats() {
    const gv = getGraduationPredictor().getVetoStats();
    return {
      ...this.stats,
      buyRate: this.stats.decisions > 0
        ? (this.stats.buys / this.stats.decisions * 100).toFixed(1) + '%'
        : '0%',
      curveEnterRate: this.stats.curveDecisions > 0
        ? (this.stats.curveEnters / this.stats.curveDecisions * 100).toFixed(1) + '%'
        : '0%',
      graduationVetos: gv.stats,
      graduationEntryRate: gv.entryRate,
    };
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _brain: AIBrain | null = null;

export function getAIBrain(): AIBrain {
  if (!_brain) {
    _brain = new AIBrain();
  }
  return _brain;
}
