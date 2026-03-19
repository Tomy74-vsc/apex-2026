import { VelocityAnalyzer, type VelocitySignal } from './VelocityAnalyzer.js';
import { BotDetector, type BotSignal } from './BotDetector.js';
import { WalletScorer, type WalletScore } from './WalletScorer.js';
import { calcBreakeven } from './BreakevenCurve.js';
import type { CurveTradeEvent, TrackedCurve } from '../../types/bonding-curve.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Weights (paper arXiv: Marino et al.)
// ═══════════════════════════════════════════════════════════════════════════════

const W_VELOCITY = 0.40;
const W_BOT_SAFETY = 0.20;
const W_SMART_MONEY = 0.15;
const W_HOLDER_DIVERSITY = 0.15;
const W_SOCIAL = 0.10;

// Normalization caps
const VELOCITY_CAP_SOL_MIN = 10;    // 10 SOL/min → score 1.0
const SMART_MONEY_CAP = 5;          // 5 smart money buyers → score 1.0

// Stage 1 veto thresholds
const VETO_AVG_TRADE_SIZE = 0.3;    // < 0.3 SOL average → not enough engagement
const VETO_BOT_RATIO = 0.7;
const VETO_VELOCITY_RATIO = 0.2;    // momentum dead

// State-based heuristic weights (no trade data fallback)
const W_HEURISTIC_PROGRESS = 0.55;  // progress sigmoid is the strongest signal
const W_HEURISTIC_SOL = 0.30;       // real SOL deposited
const W_HEURISTIC_AGE = 0.15;       // age decay (newer = faster momentum)

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface PredictionResult {
  pGrad: number;          // 0.0 – 1.0
  confidence: number;     // 0.0 – 1.0
  action: 'ENTER_CURVE' | 'SKIP';
  vetoReason: string | null;
  breakeven: number;
  safetyMarginMet: boolean;
  velocity: VelocitySignal;
  botSignal: BotSignal;
  walletScore: WalletScore;
  latencyMs: number;
}

export class GraduationPredictor {
  private readonly velocityAnalyzer = new VelocityAnalyzer();
  private readonly botDetector = new BotDetector();
  private readonly walletScorer: WalletScorer;

  constructor(smartMoneyAddresses?: Set<string>) {
    this.walletScorer = new WalletScorer(smartMoneyAddresses);
  }

  /**
   * 2-stage prediction: fast heuristic veto, then weighted score.
   *
   * @param curve - Current tracked curve state
   * @param trades - Trade history for this mint
   * @param socialScore - Normalized social score from ViralityScorer (0-1), default 0
   */
  predict(
    curve: TrackedCurve,
    trades: CurveTradeEvent[],
    socialScore = 0,
  ): PredictionResult {
    const t0 = performance.now();

    const velocity = this.velocityAnalyzer.analyze(curve.mint, trades);
    const botSignal = this.botDetector.analyze(trades);
    const walletScore = this.walletScorer.analyze(trades, curve.state.creator.toBase58());

    const realSolLamports = BigInt(Math.round(curve.realSolSOL * LAMPORTS_PER_SOL));
    const { minPGrad, minPGradWithMargin } = calcBreakeven(realSolLamports);

    const buyCount = trades.filter((t) => t.isBuy).length;

    // ─── No trade data → curve-state heuristic ──────────────────────
    if (buyCount === 0) {
      return this.predictFromCurveState(
        curve, minPGrad, minPGradWithMargin, velocity, botSignal, walletScore, t0,
      );
    }

    // ─── Stage 1: Heuristic Veto (<1ms) ─────────────────────────────

    let vetoReason: string | null = null;

    if (velocity.avgTradeSize_SOL < VETO_AVG_TRADE_SIZE) {
      vetoReason = `avgTradeSize ${velocity.avgTradeSize_SOL.toFixed(2)} < ${VETO_AVG_TRADE_SIZE}`;
    } else if (botSignal.isVeto) {
      vetoReason = `botRatio ${botSignal.botTransactionRatio.toFixed(2)} > ${VETO_BOT_RATIO}`;
    } else if (walletScore.creatorIsSelling) {
      vetoReason = 'creator is selling (rug risk)';
    } else if (velocity.velocityRatio < VETO_VELOCITY_RATIO && velocity.peakVelocity_5m > 0) {
      vetoReason = `velocityRatio ${velocity.velocityRatio.toFixed(2)} < ${VETO_VELOCITY_RATIO}`;
    }

    if (vetoReason) {
      return {
        pGrad: 0,
        confidence: 0.9,
        action: 'SKIP',
        vetoReason,
        breakeven: minPGrad,
        safetyMarginMet: false,
        velocity,
        botSignal,
        walletScore,
        latencyMs: performance.now() - t0,
      };
    }

    // ─── Stage 2: Weighted Score (future ML replacement) ─────────────

    const velocityScore = Math.min(1, velocity.solPerMinute_1m / VELOCITY_CAP_SOL_MIN);
    const botSafetyScore = 1 - botSignal.botTransactionRatio;
    const smartMoneyScore = Math.min(1, walletScore.smartMoneyBuyerCount / SMART_MONEY_CAP);
    const holderDiversityScore = 1 - walletScore.freshWalletRatio;
    const socialNorm = Math.max(0, Math.min(1, socialScore));

    const pGrad =
      W_VELOCITY * velocityScore +
      W_BOT_SAFETY * botSafetyScore +
      W_SMART_MONEY * smartMoneyScore +
      W_HOLDER_DIVERSITY * holderDiversityScore +
      W_SOCIAL * socialNorm;

    const dataConfidence = Math.min(1, buyCount / 30);
    const confidence = 0.3 + 0.7 * dataConfidence;

    const safetyMarginMet = pGrad > minPGradWithMargin;
    const action = safetyMarginMet ? 'ENTER_CURVE' : 'SKIP';

    const latencyMs = performance.now() - t0;

    if (action === 'ENTER_CURVE') {
      console.log(
        `🎯 [GradPredictor] ${curve.mint.slice(0, 8)} pGrad=${(pGrad * 100).toFixed(1)}% > breakeven=${(minPGradWithMargin * 100).toFixed(1)}% → ENTER (${latencyMs.toFixed(2)}ms)`,
      );
    }

    return {
      pGrad,
      confidence,
      action,
      vetoReason: null,
      breakeven: minPGrad,
      safetyMarginMet,
      velocity,
      botSignal,
      walletScore,
      latencyMs,
    };
  }

  /**
   * State-based heuristic when no trade microstructure data is available.
   * Uses progress sigmoid + SOL reserves + age decay to estimate pGrad.
   * Confidence is capped low (0.35) to reflect data poverty.
   */
  private predictFromCurveState(
    curve: TrackedCurve,
    minPGrad: number,
    minPGradWithMargin: number,
    velocity: VelocitySignal,
    botSignal: BotSignal,
    walletScore: WalletScore,
    t0: number,
  ): PredictionResult {
    // Sigmoid mapping: progress → graduation likelihood
    // steepness=8, midpoint=0.50 → 30%≈0.17, 50%=0.50, 70%≈0.83, 85%≈0.94
    const progressScore = 1 / (1 + Math.exp(-8 * (curve.progress - 0.50)));

    // SOL deposited signals real market interest (cap at 50 SOL)
    const solScore = Math.min(1, curve.realSolSOL / 50);

    // Age decay: newer curves at same progress = faster momentum
    const ageMinutes = (Date.now() - curve.createdAt) / 60_000;
    const ageDecay = Math.max(0, 1 - ageMinutes / 120);

    const pGrad =
      W_HEURISTIC_PROGRESS * progressScore +
      W_HEURISTIC_SOL * solScore +
      W_HEURISTIC_AGE * ageDecay;

    const confidence = 0.35;

    const safetyMarginMet = pGrad > minPGradWithMargin;
    const action = safetyMarginMet ? 'ENTER_CURVE' : 'SKIP';

    const latencyMs = performance.now() - t0;

    if (action === 'ENTER_CURVE') {
      console.log(
        `🎯 [GradPredictor:State] ${curve.mint.slice(0, 8)} pGrad=${(pGrad * 100).toFixed(1)}% > breakeven=${(minPGradWithMargin * 100).toFixed(1)}% → ENTER (heuristic, ${latencyMs.toFixed(2)}ms)`,
      );
    }

    return {
      pGrad,
      confidence,
      action,
      vetoReason: null,
      breakeven: minPGrad,
      safetyMarginMet,
      velocity,
      botSignal,
      walletScore,
      latencyMs,
    };
  }

  /** Forward to WalletScorer for creator outcome tracking. */
  recordCreatorOutcome(creator: string, graduated: boolean): void {
    this.walletScorer.recordCreatorOutcome(creator, graduated);
  }

  /** Forward to WalletScorer. */
  setSmartMoneyList(addresses: string[]): void {
    this.walletScorer.setSmartMoneyList(addresses);
  }

  /** Purge per-mint state. */
  clear(mint: string): void {
    this.velocityAnalyzer.clear(mint);
  }
}
