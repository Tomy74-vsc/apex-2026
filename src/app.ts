#!/usr/bin/env bun

/**
 * APEX-2026 - Point d'entrée principal du Bot HFT Solana
 * 
 * Orchestre tous les composants :
 * - PumpScanner : Détection temps réel des nouveaux tokens Pump.fun (courbes)
 * - TelegramPulse : Signaux sociaux Telegram
 * - Guard : Analyse de sécurité on-chain
 * - DecisionCore : Scoring et décision de trade
 * - Sniper : Exécution via Jito + Jupiter
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { DecisionCore } from './engine/DecisionCore.js';
import { TelegramPulse } from './ingestors/TelegramPulse.js';
import {
  getTelegramTokenScanner,
  type TelegramTokenScanResult,
} from './ingestors/TelegramTokenScanner.js';
import { PumpScanner } from './ingestors/PumpScanner.js';
import { getSocialTrendScanner } from './ingestors/SocialTrendScanner.js';
import { Sniper } from './executor/Sniper.js';
import { getFeatureStore } from './data/FeatureStore.js';
import { getWhaleWalletDB } from './data/WhaleWalletDB.js';
import { getAIBrain, type CurveDecision } from './engine/AIBrain.js';
import { getModelUpdater } from './engine/ModelUpdater.js';
import { getShadowAgent } from './engine/ShadowAgent.js';
import { getCurveShadowAgent } from './engine/CurveShadowAgent.js';
import { getCurveTracker } from './modules/curve-tracker/CurveTracker.js';
import type { CurveEvictionSnapshot } from './modules/curve-tracker/TieredMonitor.js';
import { CurveExecutor } from './modules/curve-executor/CurveExecutor.js';
import { GraduationExitStrategy } from './modules/curve-executor/GraduationExitStrategy.js';
import { getPositionManager } from './modules/position/PositionManager.js';
import { getPortfolioGuard } from './modules/risk/PortfolioGuard.js';
import { getGraduationPredictor } from './modules/graduation-predictor/GraduationPredictor.js';
import { getExitEngine } from './modules/position/ExitEngine.js';
import { getCurveVelocityAnalyzer } from './modules/position/curveVelocitySingleton.js';
import { getCurveTokenAnalyzer } from './detectors/CurveTokenAnalyzer.js';
import { getHolderDistributionOracle } from './modules/graduation-predictor/HolderDistribution.js';
import { attachPaperTradeLogger } from './modules/position/PaperTradeLogger.js';
import { getGrokXScanner } from './social/GrokXScanner.js';
import { getNarrativeRadar, type NarrativeSignal } from './social/NarrativeRadar.js';
import { getSentimentAggregator } from './social/SentimentAggregator.js';
import { getViralityScorer } from './nlp/ViralityScorer.js';
import { getNLPPipeline } from './nlp/NLPPipeline.js';
import type { TrackedCurve } from './types/bonding-curve.js';
import type { MarketEvent } from './types/index.js';
import { spawnSync } from 'node:child_process';

/** Windows CMD/PowerShell often default to a legacy code page → UTF-8 logs become gibberish (ÔòÉ, D├®tection). */
function ensureWindowsConsoleUtf8(): void {
  if (process.platform !== 'win32' || !process.stdout.isTTY) return;
  try {
    spawnSync('cmd.exe', ['/d', '/s', '/c', 'chcp 65001 >nul 2>&1'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    /* silencieux — terminal non standard */
  }
}

// Throttle noisy WS errors from @solana/web3.js to max 1 per 30s
const _origConsoleError = console.error;
let _lastWsErrorTs = 0;
let _wsErrorSuppressed = 0;
console.error = (...args: unknown[]) => {
  const msg = String(args[0] ?? '');
  if (msg.includes('ws error') || msg.includes('WebSocket')) {
    const now = Date.now();
    if (now - _lastWsErrorTs < 30_000) {
      _wsErrorSuppressed++;
      return;
    }
    _lastWsErrorTs = now;
    if (_wsErrorSuppressed > 0) {
      _origConsoleError(`⚠️  [WS] ${_wsErrorSuppressed} duplicate WS errors suppressed`);
      _wsErrorSuppressed = 0;
    }
  }
  _origConsoleError(...args);
};

/**
 * Configuration depuis variables d'environnement
 */
interface AppConfig {
  rpcUrl: string;
  wsUrl: string;
  tradingEnabled: boolean;
  walletPrivateKey: string;
  jitoAuthPrivateKey: string;
  jitoBlockEngineUrl: string;
  swapAmountSol: number;
  slippageBps: number;
  minLiquidity: number;
  maxRiskScore: number;
  telegramApiId?: number;
  telegramApiHash?: string;
  telegramSessionString?: string;
}

/**
 * Statistiques globales de l'application
 */
interface AppStats {
  tokensDetected: number;
  tokensAnalyzed: number;
  tokensSniped: number;
  startTime: number;
}

/**
 * Classe principale de l'application
 */
class APEXBot {
  private decisionCore: DecisionCore;
  private telegramPulse: TelegramPulse | null = null;
  private pumpScanner: PumpScanner | null = null;
  private sniper: Sniper | null = null;
  private curveExecutor: CurveExecutor | null = null;
  private stats: AppStats;
  private dashboardInterval: ReturnType<typeof setInterval> | null = null;
  private evalInterval: ReturnType<typeof setInterval> | null = null;
  private vetoStatsInterval: ReturnType<typeof setInterval> | null = null;
  private isShuttingDown: boolean = false;
  /** Phase B — throttled pGrad refresh for ExitEngine time-stop (ms). */
  private readonly livePGradRefreshMs = parseInt(process.env.LIVE_PGRAD_REFRESH_MS ?? '20000', 10) || 20_000;
  private curveLivePGradLastAt = new Map<string, number>();
  private curveLivePGradCache = new Map<string, number>();
  /** Phase C — reuse Grok/social on curveUpdate (same TTL as GROK_TOKEN_CACHE_TTL_MS). */
  private curveSocialScoreCache = new Map<
    string,
    { score: number; grokEnriched: boolean; at: number }
  >();
  private readonly SOCIAL_SCORE_TTL_MS =
    parseInt(process.env.GROK_TOKEN_CACHE_TTL_MS ?? '900000', 10) || 900_000;
  /** Un seul fetch social actif par mint (enterHotZone + polls HOT ne doublonnent pas xAI/Groq/Dex). */
  private socialFetchInflight = new Map<string, Promise<{ score: number; grokEnriched: boolean }>>();

  constructor(config: AppConfig) {
    // Initialise les statistiques
    this.stats = {
      tokensDetected: 0,
      tokensAnalyzed: 0,
      tokensSniped: 0,
      startTime: Date.now(),
    };

    // Initialise CurveExecutor si en mode curve-prediction
    try {
      this.curveExecutor = new CurveExecutor();
      console.log('✅ CurveExecutor initialisé (paper=' + ((process.env.TRADING_MODE ?? 'paper') === 'paper') + ')');
    } catch (error) {
      console.error('⚠️  Erreur initialisation CurveExecutor:', error);
    }

    // Initialise TelegramPulse si les clés sont disponibles
    if (config.telegramApiId && config.telegramApiHash) {
      try {
        this.telegramPulse = new TelegramPulse({
          apiId: config.telegramApiId,
          apiHash: config.telegramApiHash,
          sessionString: config.telegramSessionString,
        });
        console.log('✅ TelegramPulse initialisé');
      } catch (error) {
        console.error('⚠️  Erreur initialisation TelegramPulse:', error);
        console.log('⚠️  TelegramPulse désactivé');
      }
    } else {
      console.log('⚠️  TELEGRAM_API_ID ou TELEGRAM_API_HASH manquants');
      console.log('⚠️  TelegramPulse désactivé');
    }

    // Initialise PumpScanner
    try {
      this.pumpScanner = new PumpScanner({
        rpcUrl: config.rpcUrl,
        fastCheckThreshold: 30, // 30 SOL pour Pump.fun
      });
      console.log('✅ PumpScanner initialisé');
    } catch (error) {
      console.error('⚠️  Erreur initialisation PumpScanner:', error);
      console.log('⚠️  PumpScanner désactivé');
    }

    // Initialise DecisionCore (sans SocialPulse pour l'instant)
    this.decisionCore = new DecisionCore({
      minLiquidity: config.minLiquidity,
      maxRiskScore: config.maxRiskScore,
    });

    // Initialise Sniper seulement si le live trading est explicitement activé
    if (config.tradingEnabled && config.walletPrivateKey && config.jitoAuthPrivateKey) {
      try {
        const walletKeypair = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));
        const jitoAuthKeypair = Keypair.fromSecretKey(bs58.decode(config.jitoAuthPrivateKey));

        this.sniper = new Sniper({
          rpcUrl: config.rpcUrl,
          walletKeypair,
          jitoBlockEngineUrl: config.jitoBlockEngineUrl,
          jitoAuthKeypair,
          swapAmountSol: config.swapAmountSol,
          slippageBps: config.slippageBps,
        });

        console.log('✅ Sniper initialisé');
      } catch (error) {
        console.error('⚠️  Erreur initialisation Sniper:', error);
        console.log('⚠️  Le bot fonctionnera en mode analyse uniquement (pas de trades)');
      }
    } else if (!config.tradingEnabled) {
      console.log('⚠️  TRADING_ENABLED=false');
      console.log('⚠️  Live trading désactivé par défaut, mode analyse uniquement');
    } else {
      console.log('⚠️  WALLET_PRIVATE_KEY ou JITO_AUTH_PRIVATE_KEY manquants');
      console.log('⚠️  Le bot fonctionnera en mode analyse uniquement (pas de trades)');
    }

    // Configure les événements
    this.setupEventHandlers();
  }

  /**
   * Configure les handlers d'événements
   */
  private setupEventHandlers(): void {
    // Événement : Signal Telegram détecté
    if (this.telegramPulse) {
      this.telegramPulse.on('newSignal', (signal) => {
        const raw = signal.rawText ?? '';
        const tNlp = performance.now();
        void (async () => {
          try {
            const pipeline = getNLPPipeline();
            const vir = getViralityScorer();
            const nlpSig = await pipeline.process(raw, signal.mint, 'Telegram', 58, 800, {
              deferVirality: true,
            });
            vir.addMention({
              mint: signal.mint,
              platform: 'Telegram',
              authorTrustScore: 58,
              reach: 800,
              sentiment: nlpSig.sentiment,
              timestamp: signal.timestamp,
            });
            console.log(
              `📨 [Telegram→NLP] ${signal.mint.slice(0, 8)}… cat=${nlpSig.category} ` +
                `sent=${nlpSig.sentiment.toFixed(2)} ⏱️${(performance.now() - tNlp).toFixed(0)}ms`,
            );
          } catch {
            /* cold path — event loop safe */
          }
        })();
        console.log(`📨 TELEGRAM SIGNAL: ${signal.mint} (score: ${signal.score})`);
        this.stats.tokensDetected++;
      });

      this.telegramPulse.on('error', (error) => {
        console.error('[TelegramPulse] ❌ Erreur:', error);
      });
    }

    // Événement : Nouveau launch Pump.fun
    if (this.pumpScanner) {
      this.pumpScanner.on('newLaunch', (_event: MarketEvent) => {
        this.stats.tokensDetected++;
      });

      this.pumpScanner.on('error', (error) => {
        console.error('[PumpScanner] ❌ Erreur:', error);
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // V3.1 CurveTracker event wiring
    // ═══════════════════════════════════════════════════════════════════════════

    const curveTracker = getCurveTracker();
      const slipBps = parseInt(process.env.SLIPPAGE_BPS ?? '300', 10);

      attachPaperTradeLogger();

      getSocialTrendScanner().on('socialBoost', ({ mint }) => {
        try {
          const ct = getCurveTracker();
          const existing = ct.getCurveState(mint);
          if (existing && existing.tier !== 'hot') {
            ct.forcePromoteHot(mint);
          }
          const curve = ct.getCurveState(mint);
          if (curve?.tier === 'hot') {
            void this.fetchAndCacheCurveSocialScore(curve).catch(() => {});
          }
        } catch {
          /* cold path */
        }
      });

      getPositionManager().on('positionClosed', (p) => {
        this.decisionCore.updateActivePositions(-1);
        this.curveLivePGradCache.delete(p.mint);
        this.curveLivePGradLastAt.delete(p.mint);
      });

      // When a curve enters the HOT zone → run prediction pipeline
      curveTracker.on('enterHotZone', async (mint: string, curve: TrackedCurve) => {
        try {
          if (getPositionManager().hasOpenPosition(mint)) {
            return;
          }
          const trades = curveTracker.getTradeHistory(mint);
          const vel = getCurveVelocityAnalyzer().analyze(mint, trades);
          void getCurveTokenAnalyzer().analyze(curve, vel, trades).catch(() => {});
          const { score: socialScore, grokEnriched } = await this.fetchAndCacheCurveSocialScore(
            curve,
          ).catch(() => ({ score: 0, grokEnriched: false }));
          const cached = getCurveTokenAnalyzer().getCached(mint);
          const decision = await this.decisionCore.processCurveEvent(
            curve,
            trades,
            socialScore,
            grokEnriched,
            { fullAnalysisGate: cached },
          );
          await this.executeCurveBuyIfEnter(mint, curve, decision, slipBps);
        } catch (err) {
          console.error(`❌ [CurvePipeline] Error on enterHotZone for ${mint.slice(0, 8)}:`, err);
        }
      });

      // Open positions: update + exit path on every poll tier; entries only on HOT without position.
      curveTracker.on('curveUpdate', async (mint: string, curve: TrackedCurve) => {
        const pm = getPositionManager();
        try {
          const trades = curveTracker.getTradeHistory(mint);
          // ML : un snapshot HOT à chaque poll (sans cooldown predictor), avant exit/entry.
          if (curve.tier === 'hot') {
            await this.ensureSocialForHot(curve);
            const { score: obsSocial, grokEnriched: obsGrok } = this.getCachedCurveSocial(mint);
            this.decisionCore.appendHotObservationSnapshot(curve, trades, obsSocial, obsGrok);
            try {
              getHolderDistributionOracle().scheduleRefresh(mint);
            } catch {
              /* cold path */
            }
          }

          if (pm.hasOpenPosition(mint) && this.curveExecutor) {
            pm.updatePosition(mint, curve);
            const pos = pm.getPosition(mint);
            if (pos?.status === 'OPEN') {
              const velocity = getCurveVelocityAnalyzer().analyze(mint, trades);
              const nowTs = Date.now();
              let livePGrad: number | undefined = this.curveLivePGradCache.get(mint);
              const lastPg = this.curveLivePGradLastAt.get(mint) ?? 0;
              const { score: pgSocial, grokEnriched: pgGrok } = this.getCachedCurveSocial(mint);
              if (nowTs - lastPg >= this.livePGradRefreshMs) {
                try {
                  livePGrad = getAIBrain().curvePredictionPGrad(curve, trades, pgSocial, pgGrok);
                  this.curveLivePGradCache.set(mint, livePGrad);
                  this.curveLivePGradLastAt.set(mint, nowTs);
                } catch {
                  /* cold path */
                }
              }
              const exitSignal = getExitEngine().evaluate(pos, curve, velocity, { livePGrad });
              if (exitSignal) {
                if (exitSignal.action === 'GRADUATION_EXIT_3TRANCHE') {
                  const grad = new GraduationExitStrategy();
                  await grad.executeGraduationExit(
                    pos,
                    this.curveExecutor,
                    curve.state.virtualSolReserves,
                    curve.state.virtualTokenReserves,
                    slipBps,
                  );
                } else {
                  const toSell =
                    exitSignal.action === 'SELL_50PCT'
                      ? (pos.remainingTokens * 50n) / 100n
                      : pos.remainingTokens;
                  if (toSell > 0n) {
                    const sellResult = await this.curveExecutor.sell(
                      mint,
                      toSell,
                      slipBps,
                      curve.state.virtualSolReserves,
                      curve.state.virtualTokenReserves,
                    );
                    if (sellResult.success) {
                      if (exitSignal.action === 'SELL_50PCT') {
                        pm.applyPartialExit(mint, toSell, sellResult.solAmount);
                        pm.markPartialTakeProfit(mint);
                      } else {
                        pm.closeWithFinalLeg(mint, exitSignal.reason, sellResult.solAmount);
                        getCurveVelocityAnalyzer().clear(mint);
                        getExitEngine().clearCooldown(mint);
                      }
                    }
                  }
                }
              }
            }
          }

          if (!pm.hasOpenPosition(mint) && curve.tier === 'hot') {
            await this.ensureSocialForHot(curve);
            const { score: socialScore, grokEnriched } = this.getCachedCurveSocial(mint);
            const vel = getCurveVelocityAnalyzer().analyze(mint, trades);
            const cached = getCurveTokenAnalyzer().getCached(mint);
            const decision = await this.decisionCore.processCurveEvent(
              curve,
              trades,
              socialScore,
              grokEnriched,
              { fullAnalysisGate: cached },
            );
            await this.executeCurveBuyIfEnter(mint, curve, decision, slipBps);
          }
        } catch {
          /* cold path */
        }
      });

      curveTracker.on('graduated', async (mint: string, curve: TrackedCurve) => {
        try {
          if (this.curveExecutor) {
            const pos = getPositionManager().getPosition(mint);
            if (pos?.status === 'OPEN') {
              const grad = new GraduationExitStrategy();
              await grad.executeGraduationExit(
                pos,
                this.curveExecutor,
                curve.state.virtualSolReserves,
                curve.state.virtualTokenReserves,
                slipBps,
              );
            }
          }
          getAIBrain().recordCreatorOutcome(curve.state.creator.toBase58(), true);
          this.decisionCore.clearCurveCooldown(mint);
          const durationS = (Date.now() - curve.createdAt) / 1_000;
          getFeatureStore().labelCurveOutcome({
            mint,
            graduated: true,
            finalProgress: curve.progress,
            finalSol: curve.realSolSOL,
            durationS,
          });
          console.log(`🎓 [Outcomes] graduated ${mint.slice(0, 8)}…`);
          this.enrichWhaleStatsFromCurveOutcome(mint, true);
          try {
            getHolderDistributionOracle().pruneMint(mint);
          } catch {
            /* cold path */
          }
        } catch {
          // silencieux
        }
      });

      // Outcomes : TieredMonitor évince puis émet snap capturé AVANT delete (getCurveState sinon null).
      curveTracker.on('evicted', (mint: string, reason: string, snap?: CurveEvictionSnapshot) => {
        try {
          // handleGraduation émet `graduated` puis evict('graduated') : ne pas écraser labelCurveOutcome ni stats créateur.
          if (reason === 'graduated') {
            return;
          }
          if (snap?.creator) {
            getAIBrain().recordCreatorOutcome(snap.creator, false);
          }
          const durationS = snap ? (Date.now() - snap.createdAt) / 1_000 : 0;
          getFeatureStore().labelCurveOutcome({
            mint,
            graduated: false,
            finalProgress: snap?.progress ?? 0,
            finalSol: snap?.realSol ?? 0,
            durationS,
            evictionReason: reason,
          });
          console.log(`📦 [Outcomes] evicted ${mint.slice(0, 8)}… reason=${reason}`);
          this.enrichWhaleStatsFromCurveOutcome(mint, false);
          this.decisionCore.clearCurveCooldown(mint);
          try {
            getHolderDistributionOracle().pruneMint(mint);
          } catch {
            /* cold path */
          }
        } catch {
          // silencieux
        }
      });
  }

  /**
   * Exécute l'achat paper/live quand DecisionCore renvoie ENTER_CURVE.
   * (Historique : buy() n'était appelé que sur `enterHotZone` ; les ENTER après polls HOT
   * sur `curveUpdate` — ex. après VELOCITY_FIRST_WINDOW — ne passaient jamais par ici.)
   */
  private async executeCurveBuyIfEnter(
    mint: string,
    curve: TrackedCurve,
    decision: CurveDecision | null,
    slipBps: number,
  ): Promise<void> {
    if (!decision || decision.action !== 'ENTER_CURVE' || !this.curveExecutor) return;
    if (getPositionManager().hasOpenPosition(mint)) return;

    this.decisionCore.updateActivePositions(+1);
    const result = await this.curveExecutor.buy(
      mint,
      decision.positionSol,
      slipBps,
      curve.state.virtualSolReserves,
      curve.state.virtualTokenReserves,
    );
    if (result.success) {
      this.stats.tokensSniped++;
      const tOpen = performance.now();
      getPositionManager().openPosition(
        mint,
        result.solAmount,
        result.tokenAmount,
        curve,
        decision.pGrad,
        decision.breakeven,
      );
      console.log(
        `💰 [CurveExecutor] BUY ${mint.slice(0, 8)} | ${result.solAmount.toFixed(4)} SOL | sig=${result.signature?.slice(0, 16)} | ⏱️open+${(performance.now() - tOpen).toFixed(2)}ms`,
      );
    } else {
      this.decisionCore.updateActivePositions(-1);
      console.log(`❌ [CurveExecutor] BUY FAILED ${mint.slice(0, 8)}: ${result.error}`);
    }
  }

  /**
   * Si le cache social est absent ou expiré, lance un fetch complet (xAI + TG/Dex + agrégateur).
   * Appelé sur chaque poll HOT pour que le cerveau et les snapshots ML utilisent vraiment les couches sociales.
   */
  private async ensureSocialForHot(curve: TrackedCurve): Promise<void> {
    const row = this.curveSocialScoreCache.get(curve.mint);
    if (row && Date.now() - row.at <= this.SOCIAL_SCORE_TTL_MS) return;
    await this.fetchAndCacheCurveSocialScore(curve).catch(() => {});
  }

  /**
   * Phase C — Grok X + narrative + virality → composite [0,1]. Dédupliqué par mint si appels concurrents.
   */
  private fetchAndCacheCurveSocialScore(curve: TrackedCurve): Promise<{
    score: number;
    grokEnriched: boolean;
  }> {
    const mint = curve.mint;
    const existing = this.socialFetchInflight.get(mint);
    if (existing) return existing;

    const job = this.doFetchAndCacheCurveSocialScore(curve).finally(() => {
      this.socialFetchInflight.delete(mint);
    });
    this.socialFetchInflight.set(mint, job);
    return job;
  }

  /** none | additive (défaut) | cap — cap = même maths + log si composite plafonné à 1 */
  private narrativeSocialMode(): 'none' | 'additive' | 'cap' {
    const m = (process.env.NARRATIVE_SOCIAL_MODE ?? 'additive').toLowerCase().trim();
    if (m === 'none' || m === '0' || m === 'off') return 'none';
    if (m === 'cap') return 'cap';
    return 'additive';
  }

  /**
   * Booster narratif uniquement sur le composite social (alimente W_SOCIAL × socialNorm dans GraduationPredictor).
   * Plage Master Plan : ~7 % à 15 % — pas un trigger d'achat seul (vétos + breakeven margin inchangés).
   */
  private narrativeSocialBoostDelta(sig: NarrativeSignal): number {
    const minB = parseFloat(process.env.NARRATIVE_SOCIAL_BOOST_MIN ?? '0.07');
    const maxB = parseFloat(process.env.NARRATIVE_SOCIAL_BOOST_MAX ?? '0.15');
    const lo = Number.isFinite(minB) ? Math.min(Math.max(minB, 0), 1) : 0.07;
    const hi = Number.isFinite(maxB) ? Math.min(Math.max(maxB, lo), 1) : 0.15;
    const span = Math.max(0.001, hi - lo);

    const s = Math.max(
      0,
      Math.min(
        1,
        (sig.velocity / 10) * 0.35 +
          (sig.mentionSpike / 10) * 0.35 +
          Math.min(sig.verifiedSignals / 12, 1) * 0.2 +
          sig.confidence * 0.1,
      ),
    );
    let d = lo + span * s;
    const tone = sig.toneShift.toLowerCase();
    if (tone.includes('fomo') || tone.includes('euphor')) d = Math.min(hi, d + span * 0.12);
    return Math.min(hi, Math.max(lo, d));
  }

  private async doFetchAndCacheCurveSocialScore(curve: TrackedCurve): Promise<{
    score: number;
    grokEnriched: boolean;
  }> {
    const mint = curve.mint;
    const meta = curve.metadata;
    const ticker = (meta?.symbol ?? 'UNKNOWN').replace(/^\$/, '');

    const narrRadar = getNarrativeRadar();
    const narrativeMarketScore = narrRadar.getGlobalMarketMomentum();
    const xaiOn = getGrokXScanner().hasApiKey();
    const globalAge = narrRadar.getGlobalMomentumAgeMs();
    /** Grok utilisé via NarrativeRadar (scan marché global), pas requête token-level. */
    const grokEnriched = xaiOn && globalAge < 30 * 60_000;

    const tgClient = this.telegramPulse?.getClient() ?? null;
    let tgScan: TelegramTokenScanResult | null = null;
    try {
      tgScan = await getTelegramTokenScanner().analyzeMint(mint, meta, tgClient);
    } catch {
      tgScan = null;
    }
    const telegramChannelScore =
      tgScan && tgScan.source !== 'none' && tgScan.compositeScore > 0 ? tgScan.compositeScore : null;

    const narrativeMatch = getNarrativeRadar().matchesToken(meta?.name ?? '', ticker);
    const viralityScore = getViralityScorer().getViralityScore(mint);
    const dexBoosted = getSocialTrendScanner().isBoosted(mint);
    let socialScore = getSentimentAggregator().computeComposite(
      mint,
      narrativeMarketScore,
      telegramChannelScore,
      viralityScore,
      dexBoosted,
    );
    const narrMode = this.narrativeSocialMode();
    if (narrMode !== 'none') {
      if (narrativeMatch) {
        const delta = this.narrativeSocialBoostDelta(narrativeMatch);
        if (delta > 0) {
          const raw = socialScore + delta;
          socialScore = Math.min(1, raw);
          console.log(
            `📢 [Narrative] ${mint.slice(0, 8)}… "${narrativeMatch.theme}" v=${narrativeMatch.velocity} spike=${narrativeMatch.mentionSpike} verified≈${narrativeMatch.verifiedSignals} → +${delta.toFixed(2)} social (cap narratif)`,
          );
          if (narrMode === 'cap' && raw > 1 + 1e-9) {
            console.log(
              `📢 [Narrative] ${mint.slice(0, 8)}… NARRATIVE_SOCIAL_MODE=cap — composite plafonné à 1 (raw=${raw.toFixed(3)})`,
            );
          }
        }
      } else if (curve.narrativeMatch) {
        const minB = parseFloat(process.env.NARRATIVE_SOCIAL_BOOST_MIN ?? '0.07');
        const floor = Number.isFinite(minB) ? Math.min(Math.max(minB, 0), 1) : 0.07;
        const raw = socialScore + floor;
        socialScore = Math.min(1, raw);
        console.log(
          `📢 [Narrative] ${mint.slice(0, 8)}… narrativeMatch (watchlist WARM) → +${floor.toFixed(2)} social (floor)`,
        );
        if (narrMode === 'cap' && raw > 1 + 1e-9) {
          console.log(
            `📢 [Narrative] ${mint.slice(0, 8)}… NARRATIVE_SOCIAL_MODE=cap — composite plafonné à 1 (raw=${raw.toFixed(3)})`,
          );
        }
      }
    }

    this.curveSocialScoreCache.set(mint, {
      score: socialScore,
      grokEnriched,
      at: Date.now(),
    });
    return { score: socialScore, grokEnriched };
  }

  /** Enrichit whale_wallets pour les acheteurs early (courbes résolues). Cold path. */
  private enrichWhaleStatsFromCurveOutcome(mint: string, graduated: boolean): void {
    try {
      const trades = getCurveTracker().getTradeHistory(mint);
      const wdb = getWhaleWalletDB();
      if (wdb.observeBuyersFromTrades(trades)) {
        wdb.loadIntoSmartMoneyTracker();
      }
      const earlyBuyers = trades
        .filter((t) => t.isBuy && !t.synthetic && t.trader !== '_reserve_flow')
        .map((t) => t.trader);
      for (const buyer of new Set(earlyBuyers)) {
        wdb.updateStats(buyer, graduated);
      }
    } catch {
      /* cold path */
    }
  }

  private getCachedCurveSocial(mint: string): { score: number; grokEnriched: boolean } {
    const row = this.curveSocialScoreCache.get(mint);
    const stale = !row || Date.now() - row.at > this.SOCIAL_SCORE_TTL_MS;
    if (stale) {
      return { score: 0, grokEnriched: false };
    }
    if (getSocialTrendScanner().isBoosted(mint)) {
      const dexOnly = getSentimentAggregator().computeComposite(mint, 0, null, 0, true, {
        persist: false,
      });
      return { score: Math.max(row.score, dexOnly), grokEnriched: row.grokEnriched };
    }
    return { score: row.score, grokEnriched: row.grokEnriched };
  }

  /**
   * Démarre le bot
   */
  async start(): Promise<void> {
    const modeLabel = 'CURVE PREDICTION';
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log(`║     APEX-2026 - Bot HFT Solana [${modeLabel}]      ║`);
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
      // DecisionCore.start() logue déjà le détail (évite doublon "Démarrage du DecisionCore")
      await this.decisionCore.start();
      console.log('✅ DecisionCore démarré\n');

      /** PumpScanner appelle registerNewCurve → TieredMonitor doit exister avant le WS. */
      let curvePipelineReady = false;

      try {
        console.log('📈 Démarrage de CurveTracker...');
        await getCurveTracker().start();
        console.log('✅ CurveTracker démarré (mode: curve-prediction)\n');

        if (!getGrokXScanner().hasApiKey()) {
          console.log(
            '⚠️ [Social] XAI_API_KEY unset — GrokX + NarrativeRadar off (bot OK sans couche X)\n',
          );
        }
        void getNarrativeRadar()
          .start()
          .catch(() => {});

        await getSocialTrendScanner().start();

        const groqOn = !!(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim());
        const xaiOn = getGrokXScanner().hasApiKey();
        const tgSess = !!(process.env.TELEGRAM_SESSION_STRING && process.env.TELEGRAM_SESSION_STRING.trim());
        const tm = process.env.TRADING_MODE ?? 'paper';
        const te = process.env.TRADING_ENABLED === 'true';
        console.log(
          `📡 [Pipeline] Groq NLP=${groqOn ? 'on' : 'off'} | xAI Grok/Narrative=${xaiOn ? 'on' : 'off'} | ` +
            `DexScreener boosts=on | TG session=${tgSess ? 'oui (live)' : 'non → scan token via Dex proxy'}`,
        );
        console.log(
          `📡 [Pipeline] Décisions HOT: social réhydraté si cache TTL ; achats/ventes: TRADING_MODE=${tm} | TRADING_ENABLED=${te} (live on-chain requiert les deux)`,
        );

        getFeatureStore();
        getWhaleWalletDB().loadIntoSmartMoneyTracker();
        const restored = getPositionManager().restoreFromFeatureStore();
        if (restored > 0) {
          this.decisionCore.syncActiveCurveSlotCount(getPositionManager().getOpenCount());
        }
        curvePipelineReady = true;

        try {
          getPortfolioGuard().initDailyTracking(paperEquityApproxSol());
          this.schedulePortfolioDailyResetUtc();
        } catch {
          /* cold path */
        }
      } catch (error) {
        console.error('⚠️  Erreur lors du démarrage CurveTracker:', error);
        console.log('⚠️  CurveTracker désactivé — PumpScanner ne sera pas lancé (curve-prediction)\n');
      }

      // Démarre PumpScanner (AVANT TelegramPulse qui peut bloquer)
      if (this.pumpScanner) {
        if (!curvePipelineReady) {
          console.error(
            '❌ [Startup] PumpScanner ignoré : CurveTracker requis pour enregistrer les courbes (registerNewCurve).',
          );
          this.pumpScanner = null;
        } else {
          try {
            console.log('🚀 Démarrage de PumpScanner...');
            await this.pumpScanner.start();
            console.log('✅ PumpScanner démarré\n');
          } catch (error) {
            console.error('⚠️  Erreur lors du démarrage PumpScanner:', error);
            console.log('⚠️  PumpScanner désactivé\n');
            this.pumpScanner = null;
          }
        }
      }

      // Telegram dès que possible (non bloquant) → client prêt plus tôt pour TG live + NLP / Virality
      if (this.telegramPulse) {
        void this.telegramPulse
          .start()
          .then(() => console.log('✅ TelegramPulse connecté (signaux → NLP + ViralityScorer)'))
          .catch((error) => {
            console.warn('⚠️  TelegramPulse indisponible:', (error as Error).message?.slice(0, 120));
            this.telegramPulse = null;
          });
      }

      // Démarre ModelUpdater (hot-swap watcher, cold path)
      try {
        await getModelUpdater().start();
        console.log('✅ ModelUpdater démarré\n');
      } catch {
        console.log('⚠️  ModelUpdater désactivé\n');
      }

      // Démarre le tableau de bord
      this.startDashboard();
      this.startEvalLog();
      this.startVetoStatsInterval();

      console.log('✅ Bot démarré avec succès!');
      console.log('📊 Tableau de bord mis à jour toutes les 60 secondes');
      console.log('🔍 [EVAL] ligne agrégée toutes les 5 minutes (tiers + vétos prédicteur)');
      console.log(
        '📦 Collecte ML : snapshots HOT + outcomes grad/evict → `bun run export:ml` → data/*.csv (voir COLLECTION_RUNBOOK.md)',
      );
      console.log(
        '💸 Infra : Helius/RPC + DexScreener + Groq ; xAI (Grok live) + Telegram = optionnels — test xAI : `bun run verify:xai`',
      );
      console.log('🛑 Appuyez sur Ctrl+C pour arrêter proprement\n');

    } catch (error) {
      console.error('❌ Erreur lors du démarrage:', error);
      await this.shutdown();
      process.exit(1);
    }
  }

  /**
   * Arrête le bot proprement
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    ensureWindowsConsoleUtf8();
    console.log('\n');
    console.log('------------------------------------------------------------');
    console.log('  ARRET APEX — fermeture propre (flush + arret des services)');
    console.log('  (patience: WS Pump.fun / Telegram peuvent prendre 2-10 s)');
    console.log('------------------------------------------------------------');

    try {
      getNarrativeRadar().stop();
    } catch {
      /* silencieux */
    }
    try {
      getSocialTrendScanner().stop();
    } catch {
      /* silencieux */
    }
    try {
      getPositionManager().flushPersistenceSync();
      console.log('💾 [PositionManager] Open positions flushed to SQLite');
    } catch {
      /* silencieux */
    }

    // Arrête le tableau de bord
    if (this.dashboardInterval) {
      clearInterval(this.dashboardInterval);
      this.dashboardInterval = null;
    }
    if (this.evalInterval) {
      clearInterval(this.evalInterval);
      this.evalInterval = null;
    }
    if (this.vetoStatsInterval) {
      clearInterval(this.vetoStatsInterval);
      this.vetoStatsInterval = null;
    }

    // Affiche les statistiques finales
    this.displayDashboard(true);

    // Arrête DecisionCore
    try {
      await this.decisionCore.stop();
    } catch (error) {
      console.error('❌ Erreur lors de l\'arrêt du DecisionCore:', error);
    }

    try {
      await getCurveTracker().stop();
      console.log('✅ CurveTracker arrêté');
    } catch (error) {
      console.error('❌ Erreur lors de l\'arrêt CurveTracker:', error);
    }

    // Arrête PumpScanner
    if (this.pumpScanner) {
      try {
        await this.pumpScanner.stop();
        console.log('✅ PumpScanner arrêté');
      } catch (error) {
        console.error('❌ Erreur lors de l\'arrêt PumpScanner:', error);
      }
    }

    // Arrête TelegramPulse
    if (this.telegramPulse) {
      try {
        await this.telegramPulse.stop();
        console.log('✅ TelegramPulse arrêté');
      } catch (error) {
        console.error('❌ Erreur lors de l\'arrêt TelegramPulse:', error);
      }
    }

    // Arrête ModelUpdater
    try {
      getModelUpdater().stop();
    } catch {
      // silencieux
    }

    console.log('[OK] Arret du bot termine.');
  }

  /**
   * Démarre le tableau de bord périodique
   */
  private startDashboard(): void {
    // Affiche immédiatement
    this.displayDashboard();

    // Puis toutes les 60 secondes
    this.dashboardInterval = setInterval(() => {
      if (!this.isShuttingDown) {
        this.displayDashboard();
      }
    }, 60000);
  }

  /** Agrégat léger 5 min — tiers + vétos (pas de throw si métrique manquante). */
  private startEvalLog(): void {
    this.evalInterval = setInterval(() => {
      if (this.isShuttingDown) return;
      try {
        const tm = getCurveTracker().getStats();
        const veto = getAIBrain().graduationVetoStats();
        const top =
          Object.entries(veto.stats)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ') || 'N/A';
        console.log(
          `🔍 [EVAL] tiers c/w/h=${tm.cold}/${tm.warm}/${tm.hot} total=${tm.total} evict=${tm.evictions} | vetos: ${top}`,
        );
      } catch {
        console.log('🔍 [EVAL] N/A (metrics)');
      }
    }, 300_000);
  }

  /** Stats singleton GraduationPredictor toutes les 30 min (checklist paper). */
  private startVetoStatsInterval(): void {
    this.vetoStatsInterval = setInterval(() => {
      if (this.isShuttingDown) return;
      try {
        const { stats, entryRate } = getGraduationPredictor().getVetoStats();
        const top = Object.entries(stats)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([k, v]) => `${k}=${v}`)
          .join(' | ');
        console.log(`📊 [VetoStats] entryRate=${entryRate} | ${top || 'n/a'}`);
      } catch {
        /* silencieux */
      }
    }, 30 * 60 * 1000);
  }

  /**
   * Reset bankroll jour + levée halt PortfolioGuard à minuit UTC (chaînage setTimeout).
   */
  private schedulePortfolioDailyResetUtc(): void {
    const step = (): void => {
      const delay = msToNextUtcMidnight();
      setTimeout(() => {
        if (!this.isShuttingDown) {
          try {
            getPortfolioGuard().initDailyTracking(paperEquityApproxSol());
          } catch {
            /* silencieux */
          }
        }
        step();
      }, delay);
    };
    step();
  }

  /**
   * Affiche le tableau de bord dans la console
   */
  private displayDashboard(isFinal: boolean = false): void {
    const uptime = Date.now() - this.stats.startTime;
    const uptimeHours = Math.floor(uptime / 3600000);
    const uptimeMinutes = Math.floor((uptime % 3600000) / 60000);
    const uptimeSeconds = Math.floor((uptime % 60000) / 1000);

    const decisionStats = this.decisionCore.getStats();
    const telegramStats = this.telegramPulse?.getStats();
    const pumpStats = this.pumpScanner?.getStats();

    // Séparateur ASCII uniquement (=) : lisible sur toutes les consoles Windows
    const rule = '='.repeat(60);
    console.log(`\n${rule}`);
    console.log(isFinal ? '[STATS] STATISTIQUES FINALES' : '[STATS] TABLEAU DE BORD');
    console.log(rule);
    console.log(`⏱️  Uptime: ${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s`);
    console.log('');
    console.log('🔍 Détection:');
    console.log(`   Tokens détectés: ${this.stats.tokensDetected}`);
    console.log(`   Tokens analysés: ${this.stats.tokensAnalyzed}`);
    console.log(`   Tokens snipés: ${this.stats.tokensSniped}`);
    console.log('');
    console.log('📊 DecisionCore:');
    console.log(`   Traités: ${decisionStats.tokensProcessed}`);
    console.log(`   Acceptés: ${decisionStats.tokensAccepted}`);
    console.log(`   Rejetés: ${decisionStats.tokensRejected}`);
    console.log(`   Taux d'acceptation: ${decisionStats.acceptanceRate.toFixed(2)}%`);
    console.log('');
    console.log('📱 TelegramPulse:');
    console.log(`   Status: ${telegramStats ? (telegramStats.isRunning ? '✅ Actif' : '❌ Inactif') : '⚠️  Non initialisé'}`);
    if (telegramStats) {
      console.log(`   Session: ${telegramStats.hasSession ? '✅ Sauvegardée' : '❌ Non sauvegardée'}`);
    }
    console.log('');
    console.log('🚀 PumpScanner:');
    console.log(`   Status: ${pumpStats ? (pumpStats.isRunning ? '✅ Actif' : '❌ Inactif') : '⚠️  Non initialisé'}`);
    if (pumpStats) {
      console.log(`   Mode: ${pumpStats.mode} | Min SOL: ${pumpStats.minRegistrationSOL}`);
      console.log(`   WS: ${pumpStats.activeWsEndpoint} | Reconnects: ${pumpStats.wsReconnects}`);
      console.log(`   Signatures vues: ${pumpStats.processedCount} | Tx introuvables: ${pumpStats.txNotFound}`);
      if (pumpStats.mode === 'curve-prediction') {
        console.log(`   Filtrés (low SOL): ${pumpStats.filteredLowSOL} | Late stage (>80%): ${(pumpStats as any).filteredLateStage ?? 0}`);
        console.log(`   Curves enregistrées: ${pumpStats.registeredCurves} | Check failed: ${pumpStats.curveCheckFailed}`);
      }
    }
    console.log('');
    console.log('🎯 Sniper:');
    console.log(`   Status: ${this.sniper ? '✅ Actif' : '⚠️  Inactif'}`);
    if (this.sniper) {
      const sniperConfig = this.sniper.getConfig();
      console.log(`   Montant swap: ${sniperConfig.swapAmountSol} SOL`);
      console.log(`   Slippage: ${sniperConfig.slippageBps / 100}%`);
    }
    console.log('');
    const brainStats = getAIBrain().getStats();
    console.log('🧠 AIBrain:');
    console.log(`   Snipe: ${brainStats.decisions} (BUY: ${brainStats.buys} / SKIP: ${brainStats.skips}) rate=${brainStats.buyRate}`);
    console.log(
      `   Curve (decideCurve, apres EntryFilter+Guard): ${brainStats.curveDecisions} (ENTER: ${brainStats.curveEnters}) rate=${brainStats.curveEnterRate}`,
    );
    console.log(`   Avg latency: ${brainStats.avgLatencyMs.toFixed(2)}ms | Avg score: ${brainStats.avgScore.toFixed(1)}`);
    console.log('');

    {
      const gx = getGrokXScanner();
      const gxSt = gx.getStats();
      console.log('🌐 Couche sociale (résumé):');
      console.log(
        `   xAI GrokX: ${gx.hasApiKey() ? 'clé OK' : 'sans clé'} | appels=${gxSt.calls} cache=${gxSt.cached} err=${gxSt.errors} avg=${gxSt.avgLatencyMs.toFixed(0)}ms`,
      );
      console.log(
        `   NarrativeRadar: ${getNarrativeRadar().getActiveNarratives().length} thèmes actifs, watchlist ${getNarrativeRadar().getWatchlistSize()}`,
      );
      console.log(`   DexScreener boosts (mint set courant): ${getSocialTrendScanner().getBoostedMintCount()}`);
      console.log('');
      const ctStats = getCurveTracker().getStats();
      const fsStore = getFeatureStore();
      console.log('📈 CurveTracker:');
      console.log(
        `   Cold: ${ctStats.cold} | Warm: ${ctStats.warm} | Hot: ${ctStats.hot} | Total: ${ctStats.total} | Evictions: ${ctStats.evictions}`,
      );
      console.log(
        `   Evaluated: ${decisionStats.curvesEvaluated} | Entered: ${decisionStats.curvesEntered} | Cooldown: ${decisionStats.curvesSkippedCooldown} | EntryFilter [bloques]: ${decisionStats.entryGateRejected}`,
      );
      const gv = brainStats.graduationVetos as Record<string, number> | undefined;
      if (gv && Object.keys(gv).length > 0) {
        const top = Object.entries(gv)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
        console.log(`   Predictor vetos: ${top}`);
      }
      console.log(`   Curve snapshots logged: ${fsStore.getCurveSnapshotCount()}`);
      const outcomes = fsStore.getCurveOutcomeCount();
      console.log(
        `   Outcomes: ${outcomes.total} (graduated: ${outcomes.graduated}, evicted: ${outcomes.evicted})`,
      );
      console.log('');

      const bankroll = parseFloat(process.env.PAPER_BANKROLL_SOL ?? '1');
      const pm = getPositionManager();
      const port = pm.getPortfolioSummary();
      const closed = pm.getClosedPositions();
      console.log('💼 Portfolio (curve positions):');
      console.log(
        `   Bankroll(ref): ${bankroll.toFixed(3)} SOL | Invested(now): ${port.totalInvested.toFixed(4)} SOL`,
      );
      const uPct = port.totalUnrealizedPnlPct * 100;
      console.log(
        `   Open: ${port.openCount} | Unrlzd: ${port.totalUnrealizedPnl >= 0 ? '+' : ''}${port.totalUnrealizedPnl.toFixed(4)} SOL (${uPct.toFixed(1)}%)`,
      );
      for (const p of pm.getOpenPositions()) {
        const ic = p.unrealizedPnlPct >= 0 ? '+' : '-';
        console.log(
          `   [${ic}] ${p.mint.slice(0, 8)}… | ${p.originalEntrySol.toFixed(3)} SOL in | prog ${(p.currentProgress * 100).toFixed(0)}% | PnL ${(p.unrealizedPnlPct * 100).toFixed(1)}%`,
        );
      }
      console.log(
        `   Closed: ${closed.length} | WR ${(port.winRate * 100).toFixed(0)}% | Realized: ${port.totalRealizedPnl >= 0 ? '+' : ''}${port.totalRealizedPnl.toFixed(4)} SOL`,
      );
      if (port.bestTrade?.realizedPnlPct != null) {
        console.log(`   Best: +${(port.bestTrade.realizedPnlPct * 100).toFixed(1)}% (${port.bestTrade.mint.slice(0, 8)}…)`);
      }
      if (port.worstTrade?.realizedPnlPct != null) {
        console.log(`   Worst: ${(port.worstTrade.realizedPnlPct * 100).toFixed(1)}% (${port.worstTrade.mint.slice(0, 8)}…)`);
      }
      console.log('');
    }

    const shadowStats = getShadowAgent().getStats();
    console.log('👻 Shadow Agent (legacy snipe):');
    console.log(`   Decisions: ${shadowStats.totalDecisions}`);
    console.log(`   Agreement: ${shadowStats.agreementRate.toFixed(1)}%`);
    console.log(`   Shadow trades: ${shadowStats.shadowTradesLogged}`);
    console.log('');
    {
      const csh = getCurveShadowAgent().getStats();
      console.log('👻 Curve Shadow (GraduationPredictor vs policy parallèle):');
      console.log(
        `   Evaluations: ${csh.totalEvaluations} | Agreement: ${csh.agreementRate.toFixed(1)}% | ` +
          `shadow ENTER: ${csh.shadowEnters} | live ENTER: ${csh.liveEnters}`,
      );
      console.log('');
    }
    const modelStats = getModelUpdater().getStats();
    console.log('🔄 ModelUpdater:');
    console.log(`   Swaps: ${modelStats.swapCount}`);
    console.log(`   Active: ${JSON.stringify(modelStats.activeModels)}`);
    console.log(`${rule}\n`);
    if (isFinal) {
      console.log('Resume: chiffres ci-dessus = dernier etat avant arret des modules.');
      console.log('Prochaine etape: le processus va se terminer (code 0).\n');
    }
  }

  /**
   * Récupère les statistiques
   */
  getStats(): AppStats {
    return { ...this.stats };
  }
}

/** Equity paper approx : PAPER_BANKROLL_SOL + PnL (réalisé + MTM). */
function paperEquityApproxSol(): number {
  const br = parseFloat(process.env.PAPER_BANKROLL_SOL ?? '1.0');
  const base = Number.isFinite(br) && br > 0 ? br : 1;
  try {
    const s = getPositionManager().getPortfolioSummary();
    return base + s.totalRealizedPnl + s.totalUnrealizedPnl;
  } catch {
    return base;
  }
}

function msToNextUtcMidnight(): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return Math.max(1, next.getTime() - now.getTime());
}

/** Après validateEnv — clés alignées sur le code réel (pas d’invention de noms env). */
function logLaunchConfig(): void {
  const e = process.env;
  console.log(
    [
      '═══════════════════════════════════════════════',
      '🚀 APEX-2026 — Configuration de lancement',
      '═══════════════════════════════════════════════',
      `📊 Stratégie   : STRATEGY_MODE=${e.STRATEGY_MODE ?? 'curve-prediction'} | TRADING_MODE=${e.TRADING_MODE ?? 'paper'}`,
      `📈 Entrée      : progress ${e.CURVE_ENTRY_MIN_PROGRESS ?? '?'}–${e.CURVE_ENTRY_MAX_PROGRESS ?? '?'} | MIN_TRADE_COUNT=${e.MIN_TRADE_COUNT ?? '?'} | MIN_MINUTES_IN_HOT=${e.MIN_MINUTES_IN_HOT ?? '?'}`,
      `⛔ Vétos       : VETO_BOT_RATIO=${e.VETO_BOT_RATIO ?? '?'} | MIN_TRADING_INTENSITY=${e.MIN_TRADING_INTENSITY ?? '?'} | VETO_MAX_TOP10_PCT=${e.VETO_MAX_TOP10_PCT ?? '?'} | VETO_MAX_DEV_HOLDING=${e.VETO_MAX_DEV_HOLDING ?? '?'}`,
      `🛡️  Sorties     : STOP_LOSS_PCT=${e.STOP_LOSS_PCT ?? '?'} | TRAILING_STOP_PCT=${e.TRAILING_STOP_PCT ?? '?'} | HARD_MAX_HOLD_SECONDS=${e.HARD_MAX_HOLD_SECONDS ?? '?'}`,
      `💰 Risk        : MAX_CONCURRENT_CURVE_POSITIONS=${e.MAX_CONCURRENT_CURVE_POSITIONS ?? e.MAX_CONCURRENT_POSITIONS ?? '?'} | KELLY_FRACTION=${e.KELLY_FRACTION ?? '?'} | MIN_KELLY_FRACTION=${e.MIN_KELLY_FRACTION ?? '?'} | DAILY_LOSS_HALT_PCT=${e.DAILY_LOSS_HALT_PCT ?? '?'}`,
      `🧠 Safety      : SAFETY_MARGIN_BASE=${e.SAFETY_MARGIN_BASE ?? '?'} | SAFETY_MARGIN_FLOOR=${e.SAFETY_MARGIN_FLOOR ?? '?'} | NARRATIVE_SAFETY_RELAX_MAX=${e.NARRATIVE_SAFETY_RELAX_MAX ?? '?'}`,
      '═══════════════════════════════════════════════',
    ].join('\n'),
  );
}

/**
 * Fail-fast env — paper ne requiert pas de wallet ; live + TRADING_ENABLED exigent clés.
 */
function validateEnv(): void {
  const sm = process.env.STRATEGY_MODE?.trim();
  if (sm && sm !== 'curve-prediction') {
    throw new Error('STRATEGY_MODE doit être curve-prediction (snipe Raydium / MarketScanner retirés).');
  }
  if (!sm) {
    process.env.STRATEGY_MODE = 'curve-prediction';
  }
  const tm = (process.env.TRADING_MODE ?? 'paper').toLowerCase();
  const liveOn = tm === 'live' && process.env.TRADING_ENABLED === 'true';
  if (liveOn) {
    if (!(process.env.WALLET_PRIVATE_KEY ?? '').trim()) {
      throw new Error('WALLET_PRIVATE_KEY requis pour TRADING_MODE=live et TRADING_ENABLED=true');
    }
    if (!(process.env.JITO_AUTH_PRIVATE_KEY ?? '').trim()) {
      throw new Error('JITO_AUTH_PRIVATE_KEY requis pour exécution live (Jito)');
    }
  }
}

/**
 * Charge la configuration depuis les variables d'environnement
 */
function loadConfig(): AppConfig {
  const rpcUrl = process.env.HELIUS_RPC_URL || process.env.RPC_URL;
  const wsUrl = process.env.HELIUS_WS_URL || process.env.WS_URL;

  if (!rpcUrl) {
    throw new Error('HELIUS_RPC_URL ou RPC_URL doit être défini dans .env');
  }

  if (!wsUrl) {
    throw new Error('HELIUS_WS_URL ou WS_URL doit être défini dans .env');
  }

  // Vérifie les clés Telegram
  const telegramApiId = process.env.TELEGRAM_API_ID;
  const telegramApiHash = process.env.TELEGRAM_API_HASH;
  const telegramSessionString = process.env.TELEGRAM_SESSION_STRING;

  if (!telegramApiId || !telegramApiHash) {
    console.warn('⚠️  TELEGRAM_API_ID ou TELEGRAM_API_HASH manquants dans .env');
    console.warn('⚠️  TelegramPulse sera désactivé');
  }

  return {
    rpcUrl,
    wsUrl,
    tradingEnabled: process.env.TRADING_ENABLED === 'true',
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY || '',
    jitoAuthPrivateKey: process.env.JITO_AUTH_PRIVATE_KEY || '',
    jitoBlockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf',
    swapAmountSol: parseFloat(process.env.SWAP_AMOUNT_SOL || '0.1'),
    slippageBps: parseInt(process.env.SLIPPAGE_BPS || '300'),
    minLiquidity: parseFloat(process.env.MIN_LIQUIDITY || '5'),
    maxRiskScore: parseInt(process.env.MAX_RISK_SCORE || '50'),
    telegramApiId: telegramApiId ? parseInt(telegramApiId) : undefined,
    telegramApiHash: telegramApiHash || undefined,
    telegramSessionString: telegramSessionString || undefined,
  };
}

/**
 * Point d'entrée principal
 */
async function main() {
  ensureWindowsConsoleUtf8();

  let bot: APEXBot | null = null;
  let shutdownInvoked = false;

  // Gestion propre de SIGINT (Ctrl+C)
  const shutdownHandler = async (signal: string) => {
    if (shutdownInvoked) {
      console.log('\n[STOP] Second signal : sortie immediate (arret peut etre incomplet).');
      process.exit(1);
    }
    shutdownInvoked = true;
    console.log(`\n[STOP] Signal ${signal} recu (Ctrl+C) — demarrage arret propre...`);
    if (bot) {
      await bot.shutdown();
    }
    // Flush FeatureStore avant fermeture (cold path)
    try {
      await getFeatureStore().close();
    } catch {
      // silencieux
    }
    console.log('[STOP] Au revoir — processus termine (0).');
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdownHandler('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdownHandler('SIGTERM');
  });

  // Gestion des erreurs non capturées
  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
  });

  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    if (bot) {
      bot.shutdown().finally(() => process.exit(1));
    } else {
      process.exit(1);
    }
  });

  try {
    validateEnv();
    logLaunchConfig();
    const config = loadConfig();

    // Crée et démarre le bot
    bot = new APEXBot(config);
    await bot.start();

    // Garde le processus actif
    await new Promise(() => {}); // Attente infinie
  } catch (error) {
    console.error('❌ Erreur fatale:', error);
    if (bot) {
      await bot.shutdown();
    }
    process.exit(1);
  }
}

// Lance l'application
if (import.meta.main) {
  main().catch((error) => {
    console.error('❌ Erreur fatale:', error);
    process.exit(1);
  });
}

export { APEXBot };
