#!/usr/bin/env bun

/**
 * APEX-2026 - Point d'entrée principal du Bot HFT Solana
 * 
 * Orchestre tous les composants :
 * - MarketScanner : Détection temps réel des nouveaux pools Raydium
 * - PumpScanner : Détection temps réel des nouveaux tokens Pump.fun
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
import { getPriceTracker } from './data/PriceTracker.js';
import { getAIBrain } from './engine/AIBrain.js';
import { getModelUpdater } from './engine/ModelUpdater.js';
import { getShadowAgent } from './engine/ShadowAgent.js';
import { getCurveTracker } from './modules/curve-tracker/CurveTracker.js';
import type { CurveEvictionSnapshot } from './modules/curve-tracker/TieredMonitor.js';
import { CurveExecutor } from './modules/curve-executor/CurveExecutor.js';
import { GraduationExitStrategy } from './modules/curve-executor/GraduationExitStrategy.js';
import { getPositionManager } from './modules/position/PositionManager.js';
import { getExitEngine } from './modules/position/ExitEngine.js';
import { getCurveVelocityAnalyzer } from './modules/position/curveVelocitySingleton.js';
import { attachPaperTradeLogger } from './modules/position/PaperTradeLogger.js';
import { getGrokXScanner } from './social/GrokXScanner.js';
import { getNarrativeRadar } from './social/NarrativeRadar.js';
import { getSentimentAggregator } from './social/SentimentAggregator.js';
import { getViralityScorer } from './nlp/ViralityScorer.js';
import { getNLPPipeline } from './nlp/NLPPipeline.js';
import type { TrackedCurve } from './types/bonding-curve.js';
import type {
  ScoredToken,
  MarketEvent,
  TokenEventRecord,
} from './types/index.js';

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
  private readonly strategyMode: string;
  private stats: AppStats;
  private dashboardInterval: ReturnType<typeof setInterval> | null = null;
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

  constructor(config: AppConfig) {
    this.strategyMode = process.env.STRATEGY_MODE ?? 'legacy';

    // Initialise les statistiques
    this.stats = {
      tokensDetected: 0,
      tokensAnalyzed: 0,
      tokensSniped: 0,
      startTime: Date.now(),
    };

    // Initialise CurveExecutor si en mode curve-prediction
    if (this.strategyMode === 'curve-prediction') {
      try {
        this.curveExecutor = new CurveExecutor();
        console.log('✅ CurveExecutor initialisé (paper=' + ((process.env.TRADING_MODE ?? 'paper') === 'paper') + ')');
      } catch (error) {
        console.error('⚠️  Erreur initialisation CurveExecutor:', error);
      }
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
    // Événement : Token détecté par MarketScanner
    this.decisionCore.on('tokenScored', (token: ScoredToken) => {
      this.stats.tokensAnalyzed++;
      console.log(`📊 Token scoré: ${token.token.symbol} (score: ${token.finalScore}, priority: ${token.priority})`);
    });

    // ── FeatureStore : enregistre chaque décision (cold path non-bloquant) ────
    this.decisionCore.on('tokenScored', (token: ScoredToken) => {
      try {
        const store = getFeatureStore();
        const record: TokenEventRecord = {
          id: crypto.randomUUID(),
          mint: token.token.mint,
          t_source: token.t_source ?? token.timestamp ?? Date.now(),
          t_recv: token.t_recv ?? Date.now(),
          t_act: token.t_act ?? Date.now(),
          featuresJson: '[]',
          linearScore: token.finalScore,
          onnxScore: null,
          activeScore: token.finalScore,
          shadowMode: 'linear_only',
          liquiditySol: token.initialLiquiditySol,
          riskScore: token.security.riskScore,
          priority: token.priority,
          decision: 'SKIP',
          isFastCheck: false,
          detectionMs: token.latency?.detectionMs ?? null,
          guardMs: token.latency?.guardMs ?? null,
          scoringMs: token.latency?.scoringMs ?? null,
          totalMs: token.latency?.totalMs ?? null,
          createdAt: Date.now(),
        };
        store.appendEvent(record);
      } catch {
        // cold path silencieux
      }

      // PriceTracker : programme les checks de prix multi-horizon (cold path)
      try {
        getPriceTracker().track(
          token.token.mint,
          token.initialPriceUsdc,
          token.t_act ?? Date.now(),
        );
      } catch {
        // silencieux
      }
    });

    // Événement : Prêt à sniper
    this.decisionCore.on('readyToSnipe', async (token: ScoredToken) => {
      if (!this.sniper) {
        console.log('⚠️  Token prêt mais Sniper non disponible');
        return;
      }

      console.log(`\n🎯 PRÊT À SNIPER: ${token.token.symbol}`);
      console.log(`   Mint: ${token.token.mint}`);
      console.log(`   Score: ${token.finalScore}`);
      console.log(`   Priority: ${token.priority}`);
      console.log(`   Liquidité: ${token.initialLiquiditySol.toFixed(2)} SOL`);

      try {
        const signature = await this.sniper.executeSwap(token);

        if (signature) {
          this.stats.tokensSniped++;
          console.log(`✅ Swap exécuté! Signature: ${signature}`);
          console.log(`   Explorer: https://solscan.io/tx/${signature}`);
        } else {
          console.error('❌ Échec de l\'exécution du swap');
        }
      } catch (error) {
        console.error('❌ Erreur lors du snipe:', error);
      }
    });

    // Événement : Token rejeté
    this.decisionCore.on('tokenRejected', (mint: string, reason: string) => {
      // Log silencieux pour éviter spam
    });

    // Événement : Nouveau token détecté
    this.decisionCore.on('tokenDetected', (mint: string) => {
      this.stats.tokensDetected++;
      // mint parameter available for future use (logging, debugging, etc.)
    });

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
        this.decisionCore.emit('tokenDetected', signal.mint);
        this.stats.tokensDetected++;
      });

      this.telegramPulse.on('error', (error) => {
        console.error('[TelegramPulse] ❌ Erreur:', error);
      });
    }

    // Événement : Nouveau launch Pump.fun
    if (this.pumpScanner) {
      if (this.strategyMode === 'curve-prediction') {
        // V3.1: PumpScanner → CurveTracker (passive monitoring, no immediate snipe)
        this.pumpScanner.on('newLaunch', (event: MarketEvent) => {
          this.stats.tokensDetected++;
        });
      } else {
        // Legacy: PumpScanner → DecisionCore (snipe at T=0)
        this.pumpScanner.on('newLaunch', async (event: MarketEvent) => {
          console.log(`🚀 [PumpScanner] NewLaunch: ${event.token.mint}`);
          this.decisionCore.emit('tokenDetected', event.token.mint);
          this.stats.tokensDetected++;
          await this.decisionCore.processMarketEvent(event, false);
        });

        this.pumpScanner.on('fastCheck', async (event: MarketEvent) => {
          console.log(`⚡ [PumpScanner] FastCheck: ${event.token.mint}`);
          this.decisionCore.emit('tokenDetected', event.token.mint);
          this.stats.tokensDetected++;
          await this.decisionCore.processMarketEvent(event, true);
        });
      }

      this.pumpScanner.on('error', (error) => {
        console.error('[PumpScanner] ❌ Erreur:', error);
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // V3.1 CurveTracker event wiring
    // ═══════════════════════════════════════════════════════════════════════════

    if (this.strategyMode === 'curve-prediction') {
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
          const { score: socialScore, grokEnriched } = await this.fetchAndCacheCurveSocialScore(
            curve,
          ).catch(() => ({ score: 0, grokEnriched: false }));
          const decision = await this.decisionCore.processCurveEvent(
            curve,
            trades,
            socialScore,
            grokEnriched,
          );

          if (decision?.action === 'ENTER_CURVE' && this.curveExecutor) {
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
            const { score: obsSocial, grokEnriched: obsGrok } = this.getCachedCurveSocial(mint);
            this.decisionCore.appendHotObservationSnapshot(curve, trades, obsSocial, obsGrok);
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
            const { score: socialScore, grokEnriched } = this.getCachedCurveSocial(mint);
            await this.decisionCore.processCurveEvent(curve, trades, socialScore, grokEnriched);
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
          this.enrichWhaleStatsFromCurveOutcome(mint, true);
        } catch {
          // silencieux
        }
      });

      // Outcomes : TieredMonitor évince puis émet snap capturé AVANT delete (getCurveState sinon null).
      curveTracker.on('evicted', (mint: string, reason: string, snap?: CurveEvictionSnapshot) => {
        try {
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
          this.enrichWhaleStatsFromCurveOutcome(mint, false);
          this.decisionCore.clearCurveCooldown(mint);
        } catch {
          // silencieux
        }
      });
    }
  }

  /**
   * Phase C — Grok X + narrative + virality → composite [0,1]. Never throws.
   */
  private async fetchAndCacheCurveSocialScore(curve: TrackedCurve): Promise<{
    score: number;
    grokEnriched: boolean;
  }> {
    const mint = curve.mint;
    const meta = curve.metadata;
    const ticker = (meta?.symbol ?? 'UNKNOWN').replace(/^\$/, '');

    const grok = getGrokXScanner();
    const xSentiment = grok.hasApiKey()
      ? await grok.analyzeToken(ticker, mint).catch(() => null)
      : null;
    const grokEnriched = xSentiment != null;

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
      xSentiment,
      telegramChannelScore,
      viralityScore,
      dexBoosted,
    );
    if (narrativeMatch && narrativeMatch.velocity >= 7) {
      socialScore = Math.min(1, socialScore + 0.3);
      console.log(
        `📢 [Narrative] ${mint.slice(0, 8)}… matches "${narrativeMatch.theme}" v=${narrativeMatch.velocity} → social boosted`,
      );
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
      const earlyBuyers = trades.filter((t) => t.isBuy).map((t) => t.trader);
      const wdb = getWhaleWalletDB();
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
      const dexOnly = getSentimentAggregator().computeComposite(mint, null, null, 0, true);
      return { score: Math.max(row.score, dexOnly), grokEnriched: row.grokEnriched };
    }
    return { score: row.score, grokEnriched: row.grokEnriched };
  }

  /**
   * Démarre le bot
   */
  async start(): Promise<void> {
    const modeLabel = this.strategyMode === 'curve-prediction' ? 'CURVE PREDICTION' : 'LEGACY SNIPE';
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log(`║     APEX-2026 - Bot HFT Solana [${modeLabel}]      ║`);
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
      // Démarre DecisionCore (qui démarre MarketScanner)
      console.log('🚀 Démarrage du DecisionCore...');
      await this.decisionCore.start();
      console.log('✅ DecisionCore démarré\n');

      // Démarre PumpScanner (AVANT TelegramPulse qui peut bloquer)
      if (this.pumpScanner) {
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

      // Démarre CurveTracker si en mode curve-prediction
      if (this.strategyMode === 'curve-prediction') {
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

          getFeatureStore();
          getWhaleWalletDB().loadIntoSmartMoneyTracker();
          const restored = getPositionManager().restoreFromFeatureStore();
          if (restored > 0) {
            this.decisionCore.syncActiveCurveSlotCount(getPositionManager().getOpenCount());
          }
        } catch (error) {
          console.error('⚠️  Erreur lors du démarrage CurveTracker:', error);
          console.log('⚠️  CurveTracker désactivé\n');
        }
      } else {
        console.log('⚠️  STRATEGY_MODE=' + this.strategyMode + ' (CurveTracker désactivé)\n');
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

      console.log('✅ Bot démarré avec succès!');
      console.log('📊 Tableau de bord mis à jour toutes les 60 secondes');
      if (this.strategyMode === 'curve-prediction') {
        console.log(
          '📦 Collecte ML : snapshots HOT + outcomes grad/evict → `bun run export:ml` → data/*.csv (voir COLLECTION_RUNBOOK.md)',
        );
        console.log(
          '💸 Infra $0 : RPC/WS publics + DexScreener + Groq NLP ; xAI/Telegram = optionnels (crédits / compte)',
        );
      }
      console.log('🛑 Appuyez sur Ctrl+C pour arrêter proprement\n');

      // TelegramPulse en dernier — peut bloquer sur input interactif (téléphone)
      if (this.telegramPulse) {
        this.telegramPulse.start().then(() => {
          console.log('✅ TelegramPulse démarré');
        }).catch((error) => {
          console.warn('⚠️  TelegramPulse désactivé:', (error as Error).message?.slice(0, 80));
          this.telegramPulse = null;
        });
      }

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
    console.log('\n\n🛑 Arrêt du bot en cours...');

    if (this.strategyMode === 'curve-prediction') {
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
    }

    // Arrête le tableau de bord
    if (this.dashboardInterval) {
      clearInterval(this.dashboardInterval);
      this.dashboardInterval = null;
    }

    // Affiche les statistiques finales
    this.displayDashboard(true);

    // Arrête DecisionCore (qui arrête MarketScanner)
    try {
      await this.decisionCore.stop();
    } catch (error) {
      console.error('❌ Erreur lors de l\'arrêt du DecisionCore:', error);
    }

    // Arrête CurveTracker
    if (this.strategyMode === 'curve-prediction') {
      try {
        await getCurveTracker().stop();
        console.log('✅ CurveTracker arrêté');
      } catch (error) {
        console.error('❌ Erreur lors de l\'arrêt CurveTracker:', error);
      }
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

    console.log('✅ Arrêt terminé');
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

    console.log('\n' + '═'.repeat(60));
    console.log(isFinal ? '📊 STATISTIQUES FINALES' : '📊 TABLEAU DE BORD');
    console.log('═'.repeat(60));
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
    console.log(`   Curve: ${brainStats.curveDecisions} (ENTER: ${brainStats.curveEnters}) rate=${brainStats.curveEnterRate}`);
    console.log(`   Avg latency: ${brainStats.avgLatencyMs.toFixed(2)}ms | Avg score: ${brainStats.avgScore.toFixed(1)}`);
    console.log('');

    if (this.strategyMode === 'curve-prediction') {
      const ctStats = getCurveTracker().getStats();
      const fsStore = getFeatureStore();
      console.log('📈 CurveTracker:');
      console.log(
        `   Cold: ${ctStats.cold} | Warm: ${ctStats.warm} | Hot: ${ctStats.hot} | Total: ${ctStats.total} | Evictions: ${ctStats.evictions}`,
      );
      console.log(
        `   Evaluated: ${decisionStats.curvesEvaluated} | Entered: ${decisionStats.curvesEntered} | Cooldown: ${decisionStats.curvesSkippedCooldown} | EntryFilter⛔: ${decisionStats.entryGateRejected}`,
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
      console.log(`   Outcomes: ${outcomes.total} (🎓 ${outcomes.graduated} / 💀 ${outcomes.evicted})`);
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
        const ic = p.unrealizedPnlPct >= 0 ? '📈' : '📉';
        console.log(
          `   ${ic} ${p.mint.slice(0, 8)}… | ${p.originalEntrySol.toFixed(3)} SOL in | prog ${(p.currentProgress * 100).toFixed(0)}% | PnL ${(p.unrealizedPnlPct * 100).toFixed(1)}%`,
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
    console.log('👻 Shadow Agent:');
    console.log(`   Decisions: ${shadowStats.totalDecisions}`);
    console.log(`   Agreement: ${shadowStats.agreementRate.toFixed(1)}%`);
    console.log(`   Shadow trades: ${shadowStats.shadowTradesLogged}`);
    console.log('');
    const modelStats = getModelUpdater().getStats();
    console.log('🔄 ModelUpdater:');
    console.log(`   Swaps: ${modelStats.swapCount}`);
    console.log(`   Active: ${JSON.stringify(modelStats.activeModels)}`);
    console.log('═'.repeat(60) + '\n');
  }

  /**
   * Récupère les statistiques
   */
  getStats(): AppStats {
    return { ...this.stats };
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
  let bot: APEXBot | null = null;

  // Gestion propre de SIGINT (Ctrl+C)
  const shutdownHandler = async (signal: string) => {
    console.log(`\n\n📡 Signal ${signal} reçu`);
    if (bot) {
      await bot.shutdown();
    }
    // Flush FeatureStore avant fermeture (cold path)
    try {
      await getFeatureStore().close();
    } catch {
      // silencieux
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdownHandler('SIGINT'));
  process.on('SIGTERM', () => shutdownHandler('SIGTERM'));

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
    // Charge la configuration
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
