import { VelocityAnalyzer, type VelocitySignal } from './VelocityAnalyzer.js';
import { BotDetector, type BotSignal } from './BotDetector.js';
import { WalletScorer, type WalletScore } from './WalletScorer.js';
import { calcBreakevenWithConfidence } from './BreakevenCurve.js';
import type { CurveTradeEvent, TrackedCurve } from '../../types/bonding-curve.js';

// ═══════════════════════════════════════════════════════════════════════════════
// APEX_QUANT_STRATEGY §5 — 7-signal weights (Marino + velocity momentum)
// ═══════════════════════════════════════════════════════════════════════════════

const W_TRADING_INTENSITY = 0.35;
const W_VELOCITY_MOMENTUM = 0.2;
const W_ANTI_BOT = 0.15;
const W_HOLDER = 0.1;
const W_SMART_MONEY = 0.08;
const W_SOCIAL = 0.07;
const W_PROGRESS_SIGMOID = 0.05;

// Heuristic fallback (no trades) — still progress/SOL/age shaped
const W_HEURISTIC_PROGRESS = 0.55;
const W_HEURISTIC_SOL = 0.3;
const W_HEURISTIC_AGE = 0.15;

function envFloat(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

function envInt(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const MIN_TRADING_INTENSITY = () => envFloat('MIN_TRADING_INTENSITY', 0.15);
const VETO_BOT_RATIO = () => envFloat('VETO_BOT_RATIO', 0.7);
const VETO_VELOCITY_RATIO = () => envFloat('VETO_VELOCITY_RATIO', 0.2);
const CURVE_ENTRY_MIN_PROGRESS = () => envFloat('CURVE_ENTRY_MIN_PROGRESS', 0.45);
const CURVE_ENTRY_MAX_PROGRESS = () => envFloat('CURVE_ENTRY_MAX_PROGRESS', 0.85);
const VETO_MAX_AGE_MINUTES = () => envFloat('VETO_MAX_AGE_MINUTES', 45);
const VETO_MIN_FRESH_PROGRESS = () => envFloat('VETO_MIN_FRESH_PROGRESS', 0.6);
const MIN_TRADE_COUNT = () => envInt('MIN_TRADE_COUNT', 10);
const MIN_MINUTES_IN_HOT = () => envFloat('MIN_MINUTES_IN_HOT', 2);

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface PredictionResult {
  pGrad: number;
  confidence: number;
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
  private readonly vetoStats = new Map<string, number>();

  constructor(smartMoneyAddresses?: Set<string>) {
    this.walletScorer = new WalletScorer(smartMoneyAddresses);
  }

  private bumpVeto(bucket: string): void {
    this.vetoStats.set(bucket, (this.vetoStats.get(bucket) ?? 0) + 1);
  }

  getVetoStats(): Record<string, number> {
    return Object.fromEntries(this.vetoStats);
  }

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
    const buyCount = trades.filter((t) => t.isBuy).length;

    if (buyCount === 0) {
      return this.predictFromCurveState(
        curve,
        realSolLamports,
        velocity,
        botSignal,
        walletScore,
        t0,
      );
    }

    // ─── APEX §5 V1–V5 (ordre strict) puis gates roadmapv3 ─────────────
    let vetoReason: string | null = null;
    let vetoBucket: string | null = null;

    const pMin = CURVE_ENTRY_MIN_PROGRESS();
    const pMax = CURVE_ENTRY_MAX_PROGRESS();

    if (walletScore.creatorIsSelling) {
      vetoReason = 'creator is selling (rug risk)';
      vetoBucket = 'creator_selling';
    } else if (botSignal.isVeto || botSignal.botTransactionRatio > VETO_BOT_RATIO()) {
      vetoReason = `botRatio ${botSignal.botTransactionRatio.toFixed(2)} > ${VETO_BOT_RATIO()}`;
      vetoBucket = 'bot_ratio';
    } else if (velocity.avgTradeSize_SOL < MIN_TRADING_INTENSITY()) {
      vetoReason = `tradingIntensity ${velocity.avgTradeSize_SOL.toFixed(3)} < ${MIN_TRADING_INTENSITY()}`;
      vetoBucket = 'low_intensity';
    } else if (curve.progress < pMin || curve.progress > pMax) {
      vetoReason = `progress ${(curve.progress * 100).toFixed(1)}% outside [${(pMin * 100).toFixed(0)}%,${(pMax * 100).toFixed(0)}%]`;
      vetoBucket = 'progress_band';
    } else {
      const ageMinutes = (Date.now() - curve.createdAt) / 60_000;
      if (ageMinutes > VETO_MAX_AGE_MINUTES() && curve.progress < VETO_MIN_FRESH_PROGRESS()) {
        vetoReason = `stale_age: ${ageMinutes.toFixed(0)}min & progress < ${(VETO_MIN_FRESH_PROGRESS() * 100).toFixed(0)}%`;
        vetoBucket = 'stale_age';
      }
    }

    if (!vetoReason && buyCount < MIN_TRADE_COUNT()) {
      vetoReason = `insufficient_trades: ${buyCount} < ${MIN_TRADE_COUNT()}`;
      vetoBucket = 'min_trades';
    }

    if (!vetoReason && curve.lastPromotedToHot !== undefined) {
      const minutesInHot = (Date.now() - curve.lastPromotedToHot) / 60_000;
      if (minutesInHot < MIN_MINUTES_IN_HOT()) {
        vetoReason = `too_early_in_hot: ${minutesInHot.toFixed(2)}min < ${MIN_MINUTES_IN_HOT()}min`;
        vetoBucket = 'early_hot';
      }
    }

    if (!vetoReason && velocity.velocityRatio < VETO_VELOCITY_RATIO() && velocity.peakVelocity_5m > 0) {
      vetoReason = `velocityRatio ${velocity.velocityRatio.toFixed(2)} < ${VETO_VELOCITY_RATIO()}`;
      vetoBucket = 'velocity_ratio';
    }

    const dataConfidence = Math.min(1, buyCount / 30);
    const confidence = 0.3 + 0.7 * dataConfidence;
    const { minPGrad, minPGradWithMargin } = calcBreakevenWithConfidence(realSolLamports, confidence);

    if (vetoReason && vetoBucket) {
      this.bumpVeto(vetoBucket);
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

    const tradingIntensityScore = Math.min(1, velocity.avgTradeSize_SOL / 1.0);
    const velocityMomentumScore =
      Math.min(1, velocity.solPerMinute_1m / 3.0) * Math.max(0, Math.min(1, velocity.velocityRatio));
    const antiBotScore = 1 - botSignal.botTransactionRatio;
    // APEX §5 holder quality: (1 − fresh) × (1 − top10 concentration proxy)
    const holderScore = Math.max(
      0,
      Math.min(
        1,
        (1 - walletScore.freshWalletRatio) * (1 - walletScore.top10BuyVolumeShare),
      ),
    );
    const smartMoneyScore = Math.min(1, walletScore.smartMoneyBuyerCount / 3);
    const socialNorm = Math.max(0, Math.min(1, socialScore));
    const progressSigmoid = 1 / (1 + Math.exp(-12 * (curve.progress - 0.55)));

    const pGrad =
      W_TRADING_INTENSITY * tradingIntensityScore +
      W_VELOCITY_MOMENTUM * velocityMomentumScore +
      W_ANTI_BOT * antiBotScore +
      W_HOLDER * holderScore +
      W_SMART_MONEY * smartMoneyScore +
      W_SOCIAL * socialNorm +
      W_PROGRESS_SIGMOID * progressSigmoid;

    const safetyMarginMet = pGrad > minPGradWithMargin;
    const action = safetyMarginMet ? 'ENTER_CURVE' : 'SKIP';
    const latencyMs = performance.now() - t0;

    if (!safetyMarginMet) {
      this.bumpVeto('below_breakeven_margin');
    }

    if (action === 'ENTER_CURVE') {
      console.log(
        `🎯 [GradPredictor] ${curve.mint.slice(0, 8)} pGrad=${(pGrad * 100).toFixed(1)}% > thresh=${(minPGradWithMargin * 100).toFixed(1)}% → ENTER (${latencyMs.toFixed(2)}ms)`,
      );
    }

    return {
      pGrad,
      confidence,
      action,
      vetoReason: safetyMarginMet ? null : `pGrad ${(pGrad * 100).toFixed(1)}% ≤ ${(minPGradWithMargin * 100).toFixed(1)}%`,
      breakeven: minPGrad,
      safetyMarginMet,
      velocity,
      botSignal,
      walletScore,
      latencyMs,
    };
  }

  private predictFromCurveState(
    curve: TrackedCurve,
    realSolLamports: bigint,
    velocity: VelocitySignal,
    botSignal: BotSignal,
    walletScore: WalletScore,
    t0: number,
  ): PredictionResult {
    /** APEX_QUANT_STRATEGY §6 — heuristique ~0.35 ⇒ safety_margin ≈ 1.52× */
    const confidence = 0.35;
    const { minPGrad, minPGradWithMargin } = calcBreakevenWithConfidence(realSolLamports, confidence);

    const pMin = CURVE_ENTRY_MIN_PROGRESS();
    const pMax = CURVE_ENTRY_MAX_PROGRESS();
    if (curve.progress < pMin || curve.progress > pMax) {
      this.bumpVeto('heuristic_progress_band');
      return {
        pGrad: 0,
        confidence,
        action: 'SKIP',
        vetoReason: `heuristic progress outside [${(pMin * 100).toFixed(0)}%,${(pMax * 100).toFixed(0)}%]`,
        breakeven: minPGrad,
        safetyMarginMet: false,
        velocity,
        botSignal,
        walletScore,
        latencyMs: performance.now() - t0,
      };
    }

    if (walletScore.creatorIsSelling) {
      this.bumpVeto('creator_selling');
      return {
        pGrad: 0,
        confidence,
        action: 'SKIP',
        vetoReason: 'creator is selling (rug risk)',
        breakeven: minPGrad,
        safetyMarginMet: false,
        velocity,
        botSignal,
        walletScore,
        latencyMs: performance.now() - t0,
      };
    }

    const ageMinHeur = (Date.now() - curve.createdAt) / 60_000;
    if (ageMinHeur > VETO_MAX_AGE_MINUTES() && curve.progress < VETO_MIN_FRESH_PROGRESS()) {
      this.bumpVeto('heuristic_stale_age');
      return {
        pGrad: 0,
        confidence,
        action: 'SKIP',
        vetoReason: `stale_age: ${ageMinHeur.toFixed(0)}min & progress < ${(VETO_MIN_FRESH_PROGRESS() * 100).toFixed(0)}%`,
        breakeven: minPGrad,
        safetyMarginMet: false,
        velocity,
        botSignal,
        walletScore,
        latencyMs: performance.now() - t0,
      };
    }

    const progressScore = 1 / (1 + Math.exp(-8 * (curve.progress - 0.5)));
    const solScore = Math.min(1, curve.realSolSOL / 50);
    const ageMinutes = (Date.now() - curve.createdAt) / 60_000;
    const ageDecay = Math.max(0, 1 - ageMinutes / 120);

    const pGrad =
      W_HEURISTIC_PROGRESS * progressScore +
      W_HEURISTIC_SOL * solScore +
      W_HEURISTIC_AGE * ageDecay;

    const safetyMarginMet = pGrad > minPGradWithMargin;
    const action = safetyMarginMet ? 'ENTER_CURVE' : 'SKIP';
    const latencyMs = performance.now() - t0;

    if (!safetyMarginMet) {
      this.bumpVeto('heuristic_below_margin');
    }

    if (action === 'ENTER_CURVE') {
      console.log(
        `🎯 [GradPredictor:State] ${curve.mint.slice(0, 8)} pGrad=${(pGrad * 100).toFixed(1)}% > thresh=${(minPGradWithMargin * 100).toFixed(1)}% → ENTER (${latencyMs.toFixed(2)}ms)`,
      );
    }

    return {
      pGrad,
      confidence,
      action,
      vetoReason: safetyMarginMet ? null : `heuristic pGrad ≤ margin`,
      breakeven: minPGrad,
      safetyMarginMet,
      velocity,
      botSignal,
      walletScore,
      latencyMs,
    };
  }

  recordCreatorOutcome(creator: string, graduated: boolean): void {
    this.walletScorer.recordCreatorOutcome(creator, graduated);
  }

  setSmartMoneyList(addresses: string[]): void {
    this.walletScorer.setSmartMoneyList(addresses);
  }

  clear(mint: string): void {
    this.velocityAnalyzer.clear(mint);
  }
}
