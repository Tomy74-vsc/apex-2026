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
import { PumpScanner } from './ingestors/PumpScanner.js';
import { Sniper } from './executor/Sniper.js';
import type { ScoredToken, MarketEvent } from './types/index.js';

/**
 * Configuration depuis variables d'environnement
 */
interface AppConfig {
  rpcUrl: string;
  wsUrl: string;
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
  private stats: AppStats;
  private dashboardInterval: ReturnType<typeof setInterval> | null = null;
  private isShuttingDown: boolean = false;

  constructor(config: AppConfig) {
    // Initialise les statistiques
    this.stats = {
      tokensDetected: 0,
      tokensAnalyzed: 0,
      tokensSniped: 0,
      startTime: Date.now(),
    };

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

    // Initialise Sniper si les clés sont disponibles
    if (config.walletPrivateKey && config.jitoAuthPrivateKey) {
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
        console.log(`📨 TELEGRAM SIGNAL: ${signal.mint} (score: ${signal.score})`);
        // Émet tokenDetected pour déclencher l'analyse
        this.decisionCore.emit('tokenDetected', signal.mint);
        this.stats.tokensDetected++;
      });

      this.telegramPulse.on('error', (error) => {
        console.error('[TelegramPulse] ❌ Erreur:', error);
      });
    }

    // Événement : Nouveau launch Pump.fun
    if (this.pumpScanner) {
      this.pumpScanner.on('newLaunch', async (event: MarketEvent) => {
        console.log(`🚀 [PumpScanner] NewLaunch: ${event.token.mint}`);
        this.decisionCore.emit('tokenDetected', event.token.mint);
        this.stats.tokensDetected++;
        // Traite l'événement via DecisionCore
        await this.decisionCore.processMarketEvent(event, false);
      });

      this.pumpScanner.on('fastCheck', async (event: MarketEvent) => {
        console.log(`⚡ [PumpScanner] FastCheck: ${event.token.mint}`);
        this.decisionCore.emit('tokenDetected', event.token.mint);
        this.stats.tokensDetected++;
        // Traite l'événement avec priorité FastCheck
        await this.decisionCore.processMarketEvent(event, true);
      });

      this.pumpScanner.on('error', (error) => {
        console.error('[PumpScanner] ❌ Erreur:', error);
      });
    }
  }

  /**
   * Démarre le bot
   */
  async start(): Promise<void> {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║         APEX-2026 - Bot HFT Solana                      ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
      // Démarre DecisionCore (qui démarre MarketScanner)
      console.log('🚀 Démarrage du DecisionCore...');
      await this.decisionCore.start();
      console.log('✅ DecisionCore démarré\n');

      // Démarre TelegramPulse (avec gestion d'erreurs pour interaction utilisateur)
      if (this.telegramPulse) {
        try {
          console.log('📱 Démarrage de TelegramPulse...');
          await this.telegramPulse.start();
          console.log('✅ TelegramPulse démarré\n');
        } catch (error) {
          console.error('⚠️  Erreur lors du démarrage TelegramPulse:', error);
          console.log('⚠️  TelegramPulse désactivé (peut nécessiter login interactif)\n');
          this.telegramPulse = null;
        }
      }

      // Démarre PumpScanner
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

      // Démarre le tableau de bord
      this.startDashboard();

      console.log('✅ Bot démarré avec succès!');
      console.log('📊 Tableau de bord mis à jour toutes les 60 secondes');
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
    console.log('\n\n🛑 Arrêt du bot en cours...');

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
      console.log(`   Transactions traitées: ${pumpStats.processedCount}`);
    }
    console.log('');
    console.log('🎯 Sniper:');
    console.log(`   Status: ${this.sniper ? '✅ Actif' : '⚠️  Inactif'}`);
    if (this.sniper) {
      const sniperConfig = this.sniper.getConfig();
      console.log(`   Montant swap: ${sniperConfig.swapAmountSol} SOL`);
      console.log(`   Slippage: ${sniperConfig.slippageBps / 100}%`);
    }
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
