import { EventEmitter } from 'events';
import { Guard } from '../detectors/Guard.js';
import { getFeatureStore } from '../data/FeatureStore.js';
import { getAIBrain, type CurveDecision } from './AIBrain.js';
import { getCurveShadowAgent } from './CurveShadowAgent.js';
import type { CurveSnapshotRecord, FullCurveAnalysis } from '../types/index.js';
import { getPortfolioGuard } from '../modules/risk/PortfolioGuard.js';
import { getPositionManager } from '../modules/position/PositionManager.js';
import type { TrackedCurve, CurveTradeEvent } from '../types/bonding-curve.js';
import { evaluateEntryGates } from '../modules/entry/EntryFilter.js';
import { getCurveVelocityAnalyzer } from '../modules/position/curveVelocitySingleton.js';
import { getSentimentAggregator } from '../social/SentimentAggregator.js';

/**
 * Événements émis par le DecisionCore (courbe uniquement)
 */
export interface DecisionCoreEvents {
  'readyCurveBuy': (curve: TrackedCurve, decision: CurveDecision) => void;
}

/**
 * Options de configuration pour le DecisionCore (courbe — champs hérités ignorés)
 */
export interface DecisionCoreOptions {
  minLiquidity?: number;
  maxRiskScore?: number;
  fastCheckThreshold?: number;
  enableFastCheck?: boolean;
}

/** Equity paper proxy : bankroll env + PnL réalisé + non réalisé (PositionManager). */
function paperEquityApproxSol(): number {
  const br = parseFloat(process.env.PAPER_BANKROLL_SOL ?? '1.0');
  const base = Number.isFinite(br) && br > 0 ? br : 1;
  const s = getPositionManager().getPortfolioSummary();
  return base + s.totalRealizedPnl + s.totalUnrealizedPnl;
}

function assertCurveStrategyMode(): void {
  const raw = process.env.STRATEGY_MODE?.trim();
  if (raw && raw !== 'curve-prediction') {
    throw new Error(
      'APEX-2026: STRATEGY_MODE must be "curve-prediction" only — legacy MarketScanner / snipe-at-T=0 path was removed.',
    );
  }
  if (!raw) {
    process.env.STRATEGY_MODE = 'curve-prediction';
  }
}

/**
 * DecisionCore — moteur de décision bonding-curve (Pump.fun) uniquement.
 */
export class DecisionCore extends EventEmitter {
  private guard: Guard;
  private curvesEvaluated: number = 0;
  private curvesEntered: number = 0;
  private curvesSkippedCooldown: number = 0;
  private entryGateRejected: number = 0;
  private activeCurvePositions: number = 0;
  private readonly curveCooldowns: Map<string, number> = new Map();
  private readonly curveLoggedEnter: Set<string> = new Set();
  private readonly CURVE_COOLDOWN_MS = 30_000;

  constructor(_options: DecisionCoreOptions = {}) {
    super();
    assertCurveStrategyMode();
    console.log('🧹 [Architecture] Sniper strategy removed — curve-prediction only');
    this.guard = new Guard();
  }

  /**
   * Démarre le DecisionCore (pas de MarketScanner)
   */
  async start(): Promise<void> {
    console.log('🚀 Démarrage du DecisionCore (curve-prediction)…');
  }

  /**
   * Arrête le DecisionCore
   */
  async stop(): Promise<void> {
    console.log('🛑 Arrêt du DecisionCore…');
    console.log('\n📊 Statistiques finales (courbe):');
    console.log(`   - Courbes évaluées: ${this.curvesEvaluated}`);
    console.log(`   - ENTER_CURVE: ${this.curvesEntered}`);
  }

  /**
   * Append one ML snapshot for every HOT poll (predictor-only, no Guard/EntryFilter/cooldown).
   */
  appendHotObservationSnapshot(
    curve: TrackedCurve,
    trades: CurveTradeEvent[],
    socialScore = 0,
    grokEnriched = false,
  ): void {
    const t0 = performance.now();
    try {
      const prediction = getAIBrain().predictCurveOnly(curve, trades, socialScore, grokEnriched);
      const now = Date.now();
      const aggSocial = getSentimentAggregator().getScore(curve.mint);
      const socialForMl = Math.max(0, Math.min(1, Math.max(aggSocial, socialScore)));
      const snap: CurveSnapshotRecord = {
        id: crypto.randomUUID(),
        mint: curve.mint,
        timestampMs: now,
        progress: curve.progress,
        realSolSOL: curve.realSolSOL,
        priceSOL: curve.priceSOL,
        marketCapSOL: curve.marketCapSOL,
        tier: curve.tier,
        tradeCount: curve.tradeCount,
        syntheticFlowCount: curve.syntheticFlowEventCount ?? 0,
        solPerMinute1mMixed: prediction.velocity.solPerMinute1mMixed,
        solPerMinute5mMixed: prediction.velocity.solPerMinute5mMixed,
        avgTradeSizeSOLMixed: prediction.velocity.avgTradeSizeSOLMixed,
        pGrad: prediction.pGrad,
        confidence: prediction.confidence,
        breakeven: prediction.breakeven,
        action: prediction.action,
        vetoReason: prediction.vetoReason,
        solPerMinute1m: prediction.velocity.solPerMinute_1m,
        solPerMinute5m: prediction.velocity.solPerMinute_5m,
        avgTradeSizeSOL: prediction.velocity.avgTradeSize_SOL,
        velocityRatio: prediction.velocity.velocityRatio,
        botTransactionRatio: prediction.botSignal.botTransactionRatio,
        smartMoneyBuyerCount: prediction.walletScore.smartMoneyBuyerCount,
        creatorIsSelling: prediction.walletScore.creatorIsSelling ? 1 : 0,
        freshWalletRatio: prediction.walletScore.freshWalletRatio,
        socialScore: socialForMl,
        predictionMs: performance.now() - t0,
        createdAt: now,
      };
      getFeatureStore().appendCurveSnapshot(snap);
    } catch {
      /* cold path */
    }
  }

  /**
   * Process a curve that entered the HOT zone.
   * Pipeline: Guard → CurveTokenAnalyzer cache gate (when app passes `fullAnalysisGate`) → EntryFilter → AIBrain.decideCurve().
   * Gate is not env-gated: if a cached `FullCurveAnalysis` is supplied and `verdict.passed === false` or action ≠ ENTER, skip immediately.
   * If `fullAnalysisGate` is omitted or null (cache miss), this step is skipped — app should warm analysis in enterHotZone when strict gating is desired.
   */
  async processCurveEvent(
    curve: TrackedCurve,
    trades: CurveTradeEvent[],
    socialScore = 0,
    grokEnriched = false,
    opts?: { fullAnalysisGate?: import('../types/index.js').FullCurveAnalysis | null },
  ): Promise<CurveDecision | null> {
    const now = Date.now();
    const lastEval = this.curveCooldowns.get(curve.mint);
    if (lastEval && now - lastEval < this.CURVE_COOLDOWN_MS) {
      this.curvesSkippedCooldown++;
      return null;
    }
    this.curveCooldowns.set(curve.mint, now);

    this.curvesEvaluated++;
    const t0 = performance.now();

    try {
      const guardResult = await this.guard.validateCurveForExecution(curve, this.activeCurvePositions);
      if (!guardResult.allowed) {
        if (!this.curveLoggedEnter.has(curve.mint)) {
          console.log(
            `❌ [DecisionCore:Curve] ${curve.mint.slice(0, 8)} blocked by Guard: ${guardResult.flags.join(', ')}`,
          );
        }
        return null;
      }

      const fa = opts?.fullAnalysisGate;
      if (fa && (!fa.verdict.passed || fa.verdict.recommendedAction !== 'ENTER')) {
        console.log(
          `📊 [DC] ${curve.mint.slice(0, 8)}… SKIP — CurveTokenAnalyzer verdict: passed=${fa.verdict.passed} action=${fa.verdict.recommendedAction} (${(performance.now() - t0).toFixed(1)}ms)`,
        );
        return null;
      }

      const vel = getCurveVelocityAnalyzer().analyze(curve.mint, trades);
      const gate = evaluateEntryGates(curve, trades, vel);
      if (!gate.ok) {
        this.entryGateRejected++;
        console.log(
          `🚧 [DecisionCore:EntryFilter] ${curve.mint.slice(0, 8)}… ${gate.failedGate}: ${gate.detail}`,
        );
        return null;
      }

      const brain = getAIBrain();
      let decision = brain.decideCurve(curve, trades, socialScore, grokEnriched, fa);

      if (decision.action === 'ENTER_CURVE') {
        const port = getPortfolioGuard().canEnterNewPosition(decision.positionSol, {
          currentBankrollSol: paperEquityApproxSol(),
        });
        if (!port.ok) {
          console.log(`🛡️ [PortfolioGuard] ${curve.mint.slice(0, 8)}… ${port.reason ?? 'blocked'}`);
          decision = { ...decision, action: 'SKIP', positionSol: 0 };
        }
      }

      try {
        getCurveShadowAgent().evaluateCurve(curve.mint, decision);
      } catch {
        /* cold path */
      }

      if (decision.action === 'ENTER_CURVE') {
        this.curvesEntered++;
        const isFirstEnter = !this.curveLoggedEnter.has(curve.mint);
        if (isFirstEnter) {
          this.curveLoggedEnter.add(curve.mint);
          console.log(
            `✅ [DecisionCore:Curve] ENTER ${curve.mint.slice(0, 8)} | ` +
              `pGrad=${(decision.pGrad * 100).toFixed(1)}% | pos=${decision.positionSol.toFixed(3)} SOL | ` +
              `${(performance.now() - t0).toFixed(1)}ms`,
          );
        }
        this.emit('readyCurveBuy', curve, decision);
      }

      return decision;
    } catch (err) {
      console.error(`❌ [DecisionCore:Curve] Error processing ${curve.mint.slice(0, 8)}:`, err);
      return null;
    }
  }

  /** Called by app.ts when a curve position is opened/closed. */
  updateActivePositions(delta: number): void {
    this.activeCurvePositions = Math.max(0, this.activeCurvePositions + delta);
  }

  /** Align slot counter after restoring PositionManager from SQLite (curve-prediction). */
  syncActiveCurveSlotCount(openCount: number): void {
    this.activeCurvePositions = Math.max(0, Math.floor(openCount));
  }

  clearCurveCooldown(mint: string): void {
    this.curveCooldowns.delete(mint);
    this.curveLoggedEnter.delete(mint);
  }

  getStats(): {
    tokensProcessed: number;
    tokensAccepted: number;
    tokensRejected: number;
    acceptanceRate: number;
    curvesEvaluated: number;
    curvesEntered: number;
    curvesSkippedCooldown: number;
    entryGateRejected: number;
    activeCurvePositions: number;
  } {
    return {
      tokensProcessed: 0,
      tokensAccepted: 0,
      tokensRejected: 0,
      acceptanceRate: 0,
      curvesEvaluated: this.curvesEvaluated,
      curvesEntered: this.curvesEntered,
      curvesSkippedCooldown: this.curvesSkippedCooldown,
      entryGateRejected: this.entryGateRejected,
      activeCurvePositions: this.activeCurvePositions,
    };
  }
}
