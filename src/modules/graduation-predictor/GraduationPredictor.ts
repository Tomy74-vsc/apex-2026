import { VelocityAnalyzer, type VelocitySignal } from './VelocityAnalyzer.js';
import { BotDetector, type BotSignal } from './BotDetector.js';
import { WalletScorer, type WalletScore } from './WalletScorer.js';
import { calcBreakevenWithConfidence } from './BreakevenCurve.js';
import type { CurveTradeEvent, TrackedCurve } from '../../types/bonding-curve.js';
import {
  readCurveEntryMaxProgress,
  readCurveEntryMinProgress,
} from '../../constants/curve-entry-bands.js';
import { getHolderDistributionOracle } from './HolderDistribution.js';
import type { FullCurveAnalysis } from '../../types/index.js';
import { getNarrativeRadar } from '../../social/NarrativeRadar.js';

export type PredictCurveOptions = {
  suppressEnterLog?: boolean;
  fullAnalysis?: FullCurveAnalysis | null;
};

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

export type GraduationVetoStatsReport = {
  stats: Record<string, number>;
  entryRate: string;
};

export class GraduationPredictor {
  private readonly velocityAnalyzer = new VelocityAnalyzer();
  private readonly botDetector = new BotDetector();
  private readonly walletScorer: WalletScorer;
  private readonly vetoStats = new Map<string, number>();
  private totalPredictCalls = 0;
  private totalFinalEnters = 0;

  constructor(smartMoneyAddresses?: Set<string>) {
    this.walletScorer = new WalletScorer(smartMoneyAddresses);
  }

  private bumpVeto(bucket: string): void {
    this.vetoStats.set(bucket, (this.vetoStats.get(bucket) ?? 0) + 1);
  }

  /** Vétos hors predict() (ex. Kelly trop faible dans AIBrain). */
  recordVetoStat(reason: string): void {
    this.bumpVeto(reason);
  }

  /** Entrée effective après Kelly + taille (une fois par decideCurve réussi). */
  noteCurveEnterFinal(): void {
    this.totalFinalEnters++;
  }

  getVetoStats(): GraduationVetoStatsReport {
    const stats = Object.fromEntries(this.vetoStats);
    const entryRate =
      this.totalPredictCalls > 0
        ? `${this.totalFinalEnters}/${this.totalPredictCalls} (${((this.totalFinalEnters / this.totalPredictCalls) * 100).toFixed(1)}%)`
        : '0/0';
    return { stats, entryRate };
  }

  predict(
    curve: TrackedCurve,
    trades: CurveTradeEvent[],
    socialScore = 0,
    /** Réservé wiring app (social composite déjà fusionné dans socialScore, incl. booster Narrative Radar). */
    _grokEnriched = false,
    options?: PredictCurveOptions,
  ): PredictionResult {
    // Narratif Grok = pondération W_SOCIAL × socialNorm seulement — ne contourne pas les vétos ni le seuil breakeven+dynamique.
    const t0 = performance.now();
    this.totalPredictCalls++;

    const velocity = this.velocityAnalyzer.analyze(curve.mint, trades);
    const botSignal = this.botDetector.analyze(trades);
    const walletScore = this.walletScorer.analyze(trades, curve.state.creator.toBase58());

    const realSolLamports = BigInt(Math.round(curve.realSolSOL * LAMPORTS_PER_SOL));
    /** Achats wallet réels (hors flux réserve synthétique) — gates MIN_TRADE / confiance. */
    const buyCountWallet = trades.filter((t) => t.isBuy && !t.synthetic).length;

    if (buyCountWallet === 0) {
      return this.predictFromCurveState(
        curve,
        realSolLamports,
        velocity,
        botSignal,
        walletScore,
        t0,
        options,
      );
    }

    /** APEX §6 — confiance scoring pondéré bornée [0.3, 0.8] (données trades wallet). */
    let confidenceWeighted = Math.min(0.8, 0.3 + 0.7 * Math.min(1, buyCountWallet / 30));
    const fa = options?.fullAnalysis;
    if (fa?.verdict?.passed === true && !fa.partial && Number.isFinite(fa.verdict.confidence)) {
      confidenceWeighted = Math.min(0.8, Math.max(confidenceWeighted, fa.verdict.confidence));
    }

    // ─── APEX §5 V1–V5 (ordre strict) puis gates roadmapv3 ─────────────
    let vetoReason: string | null = null;
    let vetoBucket: string | null = null;

    const pMin = readCurveEntryMinProgress();
    const pMax = readCurveEntryMaxProgress();

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

    if (!vetoReason && buyCountWallet < MIN_TRADE_COUNT()) {
      vetoReason = `insufficient_trades: ${buyCountWallet} < ${MIN_TRADE_COUNT()}`;
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

    const marketMom = getNarrativeRadar().getGlobalMarketMomentum();
    const { minPGrad, minPGradWithMargin } = calcBreakevenWithConfidence(
      realSolLamports,
      confidenceWeighted,
      { marketMomentum: marketMom },
    );

    if (vetoReason && vetoBucket) {
      this.bumpVeto(vetoBucket);
      return {
        pGrad: 0,
        confidence: confidenceWeighted,
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
    const onChainTop10 = getHolderDistributionOracle().getCachedShare(curve.mint);
    let top10Conc =
      onChainTop10 !== undefined ? onChainTop10 : walletScore.top10BuyVolumeShare;
    if (fa?.holders && onChainTop10 === undefined) {
      top10Conc = Math.max(0, Math.min(1, fa.holders.top10Share));
    }
    // APEX §5 holder quality: (1 − fresh) × (1 − top10) ; top10 = supply top-10 si HOLDER_DISTRIBUTION_ENABLED, sinon proxy volume
    const holderScore = Math.max(
      0,
      Math.min(1, (1 - walletScore.freshWalletRatio) * (1 - top10Conc)),
    );
    const smartMoneyScore = Math.min(1, walletScore.smartMoneyBuyerCount / 3);
    let socialNorm = Math.max(0, Math.min(1, socialScore));
    const faSocial = fa?.social;
    if (faSocial) {
      const layer =
        faSocial.socialLayerComposite ??
        faSocial.narrativeMarketScore ??
        (faSocial.grokSentiment != null && Number.isFinite(faSocial.grokSentiment)
          ? faSocial.grokSentiment
          : null);
      if (layer != null && Number.isFinite(layer)) {
        socialNorm = Math.max(socialNorm, Math.max(0, Math.min(1, layer)));
      }
    }
    const progressSigmoid = 1 / (1 + Math.exp(-12 * (curve.progress - 0.55)));

    const numer =
      W_TRADING_INTENSITY * tradingIntensityScore +
      W_VELOCITY_MOMENTUM * velocityMomentumScore +
      W_ANTI_BOT * antiBotScore +
      W_HOLDER * holderScore +
      W_SMART_MONEY * smartMoneyScore +
      W_SOCIAL * socialNorm +
      W_PROGRESS_SIGMOID * progressSigmoid;

    const denom =
      W_TRADING_INTENSITY +
      W_VELOCITY_MOMENTUM +
      W_ANTI_BOT +
      W_HOLDER +
      W_SMART_MONEY +
      W_SOCIAL +
      W_PROGRESS_SIGMOID;

    const pGrad = denom > 0 ? numer / denom : 0;

    const safetyMarginMet = pGrad > minPGradWithMargin;
    const action = safetyMarginMet ? 'ENTER_CURVE' : 'SKIP';
    const latencyMs = performance.now() - t0;

    if (!safetyMarginMet) {
      this.bumpVeto('below_breakeven_margin');
    }

    if (action === 'ENTER_CURVE' && !options?.suppressEnterLog) {
      console.log(
        `🎯 [GradPredictor] ${curve.mint.slice(0, 8)} pGrad=${(pGrad * 100).toFixed(1)}% > thresh=${(minPGradWithMargin * 100).toFixed(1)}% → ENTER (${latencyMs.toFixed(2)}ms)`,
      );
    }

    return {
      pGrad,
      confidence: confidenceWeighted,
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
    options?: PredictCurveOptions,
  ): PredictionResult {
    /** APEX §6 — heuristique sans trades (directive / AGENTS: 0.20). */
    let confidence = 0.2;
    const faH = options?.fullAnalysis;
    if (faH?.verdict?.passed === true && !faH.partial && Number.isFinite(faH.verdict.confidence)) {
      confidence = Math.min(0.8, Math.max(confidence, faH.verdict.confidence));
    }
    const marketMomH = getNarrativeRadar().getGlobalMarketMomentum();
    const { minPGrad, minPGradWithMargin } = calcBreakevenWithConfidence(realSolLamports, confidence, {
      marketMomentum: marketMomH,
    });

    const pMin = readCurveEntryMinProgress();
    const pMax = readCurveEntryMaxProgress();
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

    if (action === 'ENTER_CURVE' && !options?.suppressEnterLog) {
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

let predictorSingleton: GraduationPredictor | null = null;

export function getGraduationPredictor(): GraduationPredictor {
  if (!predictorSingleton) predictorSingleton = new GraduationPredictor();
  return predictorSingleton;
}
