import { EventEmitter } from 'events';
import { MarketScanner } from '../ingestors/MarketScanner.js';
import { Guard } from '../detectors/Guard.js';
import { SocialPulse } from '../ingestors/SocialPulse.js';
import { getFeatureStore } from '../data/FeatureStore.js';
import { getOutcomeTracker } from './OutcomeTracker.js';
import { getAIBrain, type AIDecision, type CurveDecision } from './AIBrain.js';
import { getFeatureAssembler } from '../features/FeatureAssembler.js';
import { getShadowAgent } from './ShadowAgent.js';
import type {
  MarketEvent,
  SecurityReport,
  ScoredToken,
  SocialSignal,
  DecisionLatency,
  FeatureSnapshotRecord,
  CurveSnapshotRecord,
} from '../types/index.js';
import type { TrackedCurve, CurveTradeEvent } from '../types/bonding-curve.js';
import { evaluateEntryGates } from '../modules/entry/EntryFilter.js';
import { getCurveVelocityAnalyzer } from '../modules/position/curveVelocitySingleton.js';

/**
 * Événements émis par le DecisionCore
 */
export interface DecisionCoreEvents {
  'tokenDetected': (mint: string) => void;
  'tokenScored': (token: ScoredToken) => void;
  'readyToSnipe': (token: ScoredToken) => void;
  'tokenRejected': (mint: string, reason: string) => void;
}

/**
 * Options de configuration pour le DecisionCore
 */
export interface DecisionCoreOptions {
  minLiquidity?: number; // Liquidité minimale en SOL (défaut: 5)
  maxRiskScore?: number; // Score de risque max acceptable (défaut: 50)
  fastCheckThreshold?: number; // Threshold pour FastCheck (défaut: 100 SOL)
  enableFastCheck?: boolean; // Active/désactive FastCheck (défaut: true)
  socialPulse?: SocialPulse; // Instance de SocialPulse pour signaux sociaux
}

/**
 * DecisionCore - Moteur de décision pour le trading HFT
 * 
 * Reçoit les événements du MarketScanner, analyse via Guard,
 * calcule un score final et décide d'exécuter ou non le trade.
 */
export class DecisionCore extends EventEmitter {
  private scanner: MarketScanner | null;
  private guard: Guard;
  private socialPulse: SocialPulse | null;
  private minLiquidity: number;
  private maxRiskScore: number;
  private enableFastCheck: boolean;
  private tokensProcessed: number = 0;
  private tokensAccepted: number = 0;
  private tokensRejected: number = 0;
  private curvesEvaluated: number = 0;
  private curvesEntered: number = 0;
  private curvesSkippedCooldown: number = 0;
  private entryGateRejected: number = 0;
  private activeCurvePositions: number = 0;
  private readonly curveCooldowns: Map<string, number> = new Map();
  private readonly curveLoggedEnter: Set<string> = new Set();
  private readonly CURVE_COOLDOWN_MS = 30_000;

  constructor(options: DecisionCoreOptions = {}) {
    super();

    this.minLiquidity = options.minLiquidity || 5;
    this.maxRiskScore = options.maxRiskScore || 50;
    this.enableFastCheck = options.enableFastCheck !== false;
    this.socialPulse = options.socialPulse || null;

    const isCurveMode = process.env.STRATEGY_MODE === 'curve-prediction';

    if (!isCurveMode) {
      this.scanner = new MarketScanner({
        fastCheckThreshold: options.fastCheckThreshold || 100,
      });
      this.setupScannerEvents();
    } else {
      this.scanner = null;
      console.log('⚠️ [DecisionCore] MarketScanner disabled (curve-prediction mode — saves RPC quota)');
    }

    this.guard = new Guard();
  }

  /**
   * Configure les événements du MarketScanner
   */
  private setupScannerEvents(): void {
    if (!this.scanner) return;
    const scanner = this.scanner;

    scanner.on('newToken', async (event: MarketEvent) => {
      this.emit('tokenDetected', event.token.mint);
      await this.processToken(event, false);
    });

    if (this.enableFastCheck) {
      scanner.on('fastCheck', async (event: MarketEvent) => {
        this.emit('tokenDetected', event.token.mint);
        console.log('⚡ FastCheck déclenché pour:', event.token.mint);
        await this.processToken(event, true);
      });
    }

    scanner.on('connected', () => {
      console.log('✅ DecisionCore: Scanner connecté');
    });

    scanner.on('error', (error: Error) => {
      console.error('❌ DecisionCore: Erreur scanner:', error);
    });
  }

  /**
   * Démarre le DecisionCore
   */
  async start(): Promise<void> {
    console.log('🚀 Démarrage du DecisionCore...');
    console.log(`   - Liquidité min: ${this.minLiquidity} SOL`);
    console.log(`   - Risk score max: ${this.maxRiskScore}`);
    console.log(`   - FastCheck: ${this.enableFastCheck ? 'Activé' : 'Désactivé'}\n`);

    if (this.scanner) {
      await this.scanner.start();
    }
  }

  /**
   * Arrête le DecisionCore
   */
  async stop(): Promise<void> {
    console.log('🛑 Arrêt du DecisionCore...');
    if (this.scanner) {
      await this.scanner.stop();
    }
    
    console.log('\n📊 Statistiques finales:');
    console.log(`   - Tokens traités: ${this.tokensProcessed}`);
    console.log(`   - Tokens acceptés: ${this.tokensAccepted}`);
    console.log(`   - Tokens rejetés: ${this.tokensRejected}`);
  }

  /**
   * Traite un MarketEvent externe (depuis PumpScanner ou autres sources)
   * 
   * @param event - Événement MarketEvent
   * @param isFastCheck - True si c'est un FastCheck (priorité absolue)
   */
  async processMarketEvent(event: MarketEvent, isFastCheck: boolean = false): Promise<void> {
    await this.processToken(event, isFastCheck);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V3.1 Curve-Prediction Pipeline
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Process a curve that entered the HOT zone.
   * Pipeline: Guard.validateCurve() → AIBrain.decideCurve() → emit readyCurveBuy / log
   */
  async processCurveEvent(
    curve: TrackedCurve,
    trades: CurveTradeEvent[],
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
      const guardResult = this.guard.validateCurve(curve, this.activeCurvePositions);
      if (!guardResult.allowed) {
        if (!this.curveLoggedEnter.has(curve.mint)) {
          console.log(
            `❌ [DecisionCore:Curve] ${curve.mint.slice(0, 8)} blocked by Guard: ${guardResult.flags.join(', ')}`,
          );
        }
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
      const decision = brain.decideCurve(curve, trades);

      try {
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
          pGrad: decision.pGrad,
          confidence: decision.confidence,
          breakeven: decision.breakeven,
          action: decision.action,
          vetoReason: decision.prediction.vetoReason,
          solPerMinute1m: decision.prediction.velocity.solPerMinute_1m,
          solPerMinute5m: decision.prediction.velocity.solPerMinute_5m,
          avgTradeSizeSOL: decision.prediction.velocity.avgTradeSize_SOL,
          velocityRatio: decision.prediction.velocity.velocityRatio,
          botTransactionRatio: decision.prediction.botSignal.botTransactionRatio,
          smartMoneyBuyerCount: decision.prediction.walletScore.smartMoneyBuyerCount,
          creatorIsSelling: decision.prediction.walletScore.creatorIsSelling ? 1 : 0,
          freshWalletRatio: decision.prediction.walletScore.freshWalletRatio,
          predictionMs: decision.latencyMs,
          createdAt: now,
        };
        getFeatureStore().appendCurveSnapshot(snap);
      } catch {
        // cold path silencieux
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

  /**
   * Traite un token detecte
   *
   * Pipeline V3 : Guard → FeatureAssembler → AIBrain.decide() → emit
   */
  private async processToken(event: MarketEvent, isFastCheck: boolean): Promise<void> {
    this.tokensProcessed++;

    const t_source = event.t_source ?? event.timestamp ?? Date.now();
    const t_recv = event.t_recv ?? Date.now();

    try {
      const { token, initialLiquiditySol } = event;

      const SYSTEM_MINTS = new Set([
        '11111111111111111111111111111111',
        'ComputeBudget111111111111111111111111111111',
        'So11111111111111111111111111111111111111112',
      ]);

      if (SYSTEM_MINTS.has(token.mint)) {
        return;
      }

      if (initialLiquiditySol < this.minLiquidity) {
        this.rejectToken(
          token.mint,
          `Liquidité insuffisante: ${initialLiquiditySol.toFixed(2)} SOL`,
        );
        return;
      }

      // ─── Guard ────────────────────────────────────────────────────────
      console.log(`🔍 Analyse sécurité: ${token.mint}${isFastCheck ? ' [FAST]' : ''}`);
      const guardStart = performance.now();
      const security: SecurityReport = await this.guard.validateToken(token.mint);
      const guardMs = Math.round(performance.now() - guardStart);

      if (security.riskScore > this.maxRiskScore) {
        this.rejectToken(
          token.mint,
          `Risk score trop élevé: ${security.riskScore} (max: ${this.maxRiskScore})`,
        );
        return;
      }

      if (!security.isSafe) {
        this.rejectToken(token.mint, `Token non sûr: ${security.flags.join(', ')}`);
        return;
      }

      // ─── Social Signal ────────────────────────────────────────────────
      const socialSignal = this.socialPulse
        ? await this.socialPulse.getSignal(token.mint)
        : null;

      // ─── Feature Assembly (V3) ────────────────────────────────────────
      const assembler = getFeatureAssembler();
      const features = assembler.assemble(
        token.mint,
        initialLiquiditySol,
        event.initialPriceUsdc,
        socialSignal?.sentiment ?? 0,
      );

      // ─── AIBrain Decision (replaces linear scoring) ───────────────────
      const scoreStart = performance.now();
      const securityScore = Math.max(0, 100 - security.riskScore);
      const linearScore = this.calculateFinalScore(event, security, socialSignal, isFastCheck);

      const brain = getAIBrain();
      const aiDecision: AIDecision = brain.decide(
        token.mint,
        features,
        securityScore,
        isFastCheck,
        linearScore,
      );
      const scoringMs = Math.round((performance.now() - scoreStart) * 100) / 100;

      // Use AI score as the authoritative score
      const finalScore = aiDecision.aiScore;

      const t_act = Date.now();
      const totalMs = t_act - t_source;

      const latency: DecisionLatency = {
        detectionMs: Math.max(0, t_recv - t_source),
        guardMs,
        scoringMs,
        totalMs: Math.max(0, totalMs),
      };

      console.log(
        `⏱️  [${token.mint.slice(0, 8)}] detect=${latency.detectionMs}ms | guard=${latency.guardMs}ms | ` +
          `ai=${aiDecision.breakdown.totalMs.toFixed(1)}ms | TOTAL=${latency.totalMs}ms`,
      );

      // Priority from AIBrain confidence + regime
      const priority = this.determinePriorityV3(aiDecision, initialLiquiditySol, isFastCheck);

      const scoredToken: ScoredToken = {
        ...event,
        t_act,
        social: socialSignal,
        security,
        finalScore,
        priority,
        latency,
        aiDecision: {
          action: aiDecision.action,
          aiScore: aiDecision.aiScore,
          confidence: aiDecision.confidence,
          regime: aiDecision.regime,
          kellyFraction: aiDecision.kelly.kellyFraction,
          positionSol: aiDecision.kelly.positionSol,
          latencyMs: aiDecision.latencyMs,
        },
      };

      this.emit('tokenScored', scoredToken);

      // V3 Feature Logger — real assembled features (cold path)
      try {
        const snap = assembler.toSnapshot(
          features,
          isFastCheck ? 'pump' : 'websocket',
        );
        snap.latencyMs = latency.totalMs;
        getFeatureStore().appendFeatureSnapshot(snap);
        getOutcomeTracker().track(snap.id, token.mint, event.initialPriceUsdc);
      } catch {
        // cold path silencieux
      }

      // Shadow Agent — RL comparison (cold path, fire-and-forget)
      try {
        getShadowAgent().evaluate(token.mint, features, aiDecision);
      } catch {
        // cold path silencieux
      }

      // AIBrain decides snipe eligibility
      if (aiDecision.action === 'BUY') {
        this.tokensAccepted++;
        console.log(
          `✅ Token accepté: ${token.mint} | AI=${finalScore} | linear=${linearScore} | ` +
            `regime=${aiDecision.regime} | kelly=${(aiDecision.kelly.kellyFraction * 100).toFixed(1)}% | priority=${priority}`,
        );
        this.emit('readyToSnipe', scoredToken);
      } else {
        this.rejectToken(
          token.mint,
          `AIBrain SKIP: score=${finalScore} conf=${aiDecision.confidence.toFixed(2)} regime=${aiDecision.regime}`,
        );
      }
    } catch (error) {
      console.error('❌ Erreur lors du traitement du token:', error);
      this.rejectToken(event.token.mint, `Erreur: ${error}`);
    }
  }

  /**
   * Calcule le score final d'un token
   * 
   * @param event - MarketEvent
   * @param security - SecurityReport du Guard
   * @param socialSignal - SocialSignal de SocialPulse (peut être null)
   * @param isFastCheck - True si FastCheck
   * @returns Score de 0 à 100
   */
  private calculateFinalScore(
    event: MarketEvent,
    security: SecurityReport,
    socialSignal: SocialSignal | null,
    isFastCheck: boolean
  ): number {
    let score = 0;

    // 1. Score de sécurité (40 points max)
    // Inverse du risk score : moins de risque = plus de points
    const securityScore = Math.max(0, 40 - (security.riskScore * 0.4));
    score += securityScore;

    // 2. Score de liquidité (30 points max)
    const liquidityScore = Math.min(30, event.initialLiquiditySol * 0.3);
    score += liquidityScore;

    // 3. Bonus autorités révoquées (15 points)
    if (security.details.mintRenounced && security.details.freezeDisabled) {
      score += 15;
    }

    // 4. Bonus LP burned (10 points)
    if (security.details.lpBurnedPercent > 90) {
      score += 10;
    } else if (security.details.lpBurnedPercent > 50) {
      score += 5;
    }

    // 5. Score social (20 points max si disponible)
    if (socialSignal) {
      // Velocity boost (10 points max)
      const velocityScore = Math.min(10, socialSignal.velocity30s * 0.4);
      score += velocityScore;

      // Trust score boost (5 points max)
      const trustScore = (socialSignal.authorTrustScore / 100) * 5;
      score += trustScore;

      // Sentiment boost (5 points max)
      const sentimentScore = Math.max(0, socialSignal.sentiment * 5);
      score += sentimentScore;
    }

    // 6. Bonus FastCheck (5 points)
    if (isFastCheck) {
      score += 5;
    }

    return Math.min(100, Math.round(score));
  }

  /**
   * V3 priority using AIBrain decision context.
   */
  private determinePriorityV3(
    decision: AIDecision,
    liquiditySol: number,
    isFastCheck: boolean,
  ): 'HIGH' | 'MEDIUM' | 'LOW' {
    if (decision.action === 'SKIP') return 'LOW';

    // HIGH: strong regime + high confidence + good Kelly
    if (
      decision.regime === 'Trending' &&
      decision.confidence >= 0.6 &&
      decision.kelly.kellyFraction >= 0.05
    ) {
      return 'HIGH';
    }

    if (isFastCheck && decision.aiScore >= 70) return 'HIGH';
    if (decision.aiScore >= 80 || (liquiditySol >= 50 && decision.aiScore >= 70)) return 'HIGH';
    if (decision.aiScore >= 65) return 'MEDIUM';

    return 'LOW';
  }

  /**
   * Legacy priority (kept for backward compat / linear score comparison)
   */
  private determinePriority(
    finalScore: number,
    liquiditySol: number,
    isFastCheck: boolean,
  ): 'HIGH' | 'MEDIUM' | 'LOW' {
    if (isFastCheck && finalScore >= 70) return 'HIGH';
    if (finalScore >= 80 || (liquiditySol >= 50 && finalScore >= 70)) return 'HIGH';
    if (finalScore >= 70) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * Rejette un token
   */
  private rejectToken(mint: string, reason: string): void {
    this.tokensRejected++;
    console.log(`❌ Token rejeté: ${mint.slice(0, 8)}... - ${reason}`);
    this.emit('tokenRejected', mint, reason);
  }

  /**
   * Statistiques du DecisionCore
   */
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
      tokensProcessed: this.tokensProcessed,
      tokensAccepted: this.tokensAccepted,
      tokensRejected: this.tokensRejected,
      acceptanceRate: this.tokensProcessed > 0 
        ? (this.tokensAccepted / this.tokensProcessed) * 100 
        : 0,
      curvesEvaluated: this.curvesEvaluated,
      curvesEntered: this.curvesEntered,
      curvesSkippedCooldown: this.curvesSkippedCooldown,
      entryGateRejected: this.entryGateRejected,
      activeCurvePositions: this.activeCurvePositions,
    };
  }
}
