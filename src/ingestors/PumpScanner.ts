import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { getMint } from '@solana/spl-token';
import type { MarketEvent, TokenMetadata } from '../types/index.js';

/**
 * PumpScanner - Surveillance temps réel des nouveaux tokens Pump.fun
 * 
 * Architecture High Performance (Free Tier Optimized):
 * - WebSocket natif via connection.onLogs (plus stable que gRPC gratuit)
 * - Commitment 'processed' pour latence minimale (< 50ms)
 * - Filtrage rapide sur logs ("Instruction: Create" / "InitializeMint")
 * - Extraction Mint depuis postTokenBalances (heuristique balance géante)
 * - Dédoublonnage intelligent avec Set<string>
 * 
 * Latence cible: < 100ms de la création à l'événement newLaunch
 */

// Pump.fun Program ID (mainnet-beta)
const PUMPFUN_PROGRAM_ID = new PublicKey('6EF8rSdqWSwisY94eDD4MpzoQzeD9F8H5JyoC1q282J3');

/**
 * Événements émis par PumpScanner
 */
export interface PumpScannerEvents {
  'newLaunch': (event: MarketEvent) => void;
  'fastCheck': (event: MarketEvent) => void;
  'error': (error: Error) => void;
  'connected': () => void;
  'disconnected': () => void;
}

/**
 * Options de configuration pour PumpScanner
 */
export interface PumpScannerOptions {
  rpcUrl?: string;
  wsUrl?: string;
  fastCheckThreshold?: number; // SOL threshold pour FastCheck (défaut: 30 SOL)
}

export class PumpScanner extends EventEmitter {
  private connection: Connection;
  private wsConnection: Connection;
  private subscriptionId: number | null = null;
  private processedSignatures: Set<string> = new Set();
  private isRunning: boolean = false;
  private fastCheckThreshold: number;
  private readonly MAX_CACHE_SIZE = 1000; // Nettoie le Set si > 1000

  constructor(options: PumpScannerOptions = {}) {
    super();

    const rpcUrl = options.rpcUrl || process.env.HELIUS_RPC_URL || process.env.RPC_URL;
    const wsUrl = options.wsUrl || process.env.HELIUS_WS_URL || rpcUrl?.replace('https://', 'wss://');

    if (!rpcUrl) {
      throw new Error('RPC URL must be provided via options or HELIUS_RPC_URL env var');
    }

    if (!wsUrl) {
      throw new Error('WebSocket URL must be provided via options or HELIUS_WS_URL env var');
    }

    // Connection pour les requêtes RPC (getTransaction)
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 30000,
    });

    // Connection WebSocket dédiée pour onLogs (commitment 'processed')
    this.wsConnection = new Connection(wsUrl, {
      commitment: 'processed', // Le plus rapide disponible
      wsEndpoint: wsUrl,
    });

    this.fastCheckThreshold = options.fastCheckThreshold || 30; // 30 SOL par défaut pour Pump.fun
  }

  /**
   * Démarre la surveillance Pump.fun via WebSocket
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('[PumpScanner] ⚠️ Déjà en cours d\'exécution');
      return;
    }

    try {
      console.log('[PumpScanner] 🚀 Démarrage...');
      console.log(`📊 Programme surveillé: ${PUMPFUN_PROGRAM_ID.toBase58()}`);
      console.log(`⚡ FastCheck threshold: ${this.fastCheckThreshold} SOL`);
      console.log(`⚡ Commitment: processed (latence minimale)`);

      // Souscription aux logs du programme Pump.fun avec commitment 'processed'
      this.subscriptionId = this.wsConnection.onLogs(
        PUMPFUN_PROGRAM_ID,
        async (logs, context) => {
          // Gestion d'erreurs silencieuse pour ne pas crasher la boucle
          try {
            await this.handleLogs(logs, context);
          } catch (error) {
            // Erreur silencieuse (log uniquement en debug)
            // Ne pas émettre d'erreur pour éviter de spammer
          }
        },
        'processed' // Commitment le plus rapide
      );

      this.isRunning = true;
      this.emit('connected');
      console.log('[PumpScanner] ✅ Connecté et en écoute\n');
    } catch (error) {
      console.error('[PumpScanner] ❌ Erreur lors du démarrage:', error);
      this.emit('error', error as Error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Arrête la surveillance
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log('[PumpScanner] 🛑 Arrêt en cours...');

    if (this.subscriptionId !== null) {
      try {
        await this.wsConnection.removeOnLogsListener(this.subscriptionId);
        this.subscriptionId = null;
      } catch (error) {
        // Erreur silencieuse lors de la déconnexion
      }
    }

    this.isRunning = false;
    this.emit('disconnected');
    console.log('[PumpScanner] ✅ Arrêté');
  }

  /**
   * Gère les logs reçus du WebSocket
   * 
   * Filtre rapide sur les logs pour détecter "Instruction: Create" ou "InitializeMint"
   * 
   * @param logs - Logs de la transaction
   * @param context - Contexte (slot, etc.)
   */
  private async handleLogs(logs: any, context: any): Promise<void> {
    // ⚡ t_recv : capturé immédiatement — avant toute logique
    const t_recv = Date.now();

    // Ignore les transactions échouées
    if (logs.err) {
      return;
    }

    const signature = logs.signature;
    if (!signature) {
      return;
    }

    // Dédoublonnage : vérifie si déjà traité
    if (this.processedSignatures.has(signature)) {
      return;
    }

    // Nettoie le cache si trop grand
    if (this.processedSignatures.size >= this.MAX_CACHE_SIZE) {
      // Nettoie les 500 plus anciennes (stratégie FIFO approximative)
      const toDelete = Array.from(this.processedSignatures).slice(0, 500);
      toDelete.forEach((sig) => this.processedSignatures.delete(sig));
    }

    // Marque comme en cours de traitement
    this.processedSignatures.add(signature);

    // Filtre rapide sur les logs : recherche "Instruction: Create" ou "InitializeMint"
    const logString = logs.logs?.join(' ') || '';
    
    const hasCreateInstruction = 
      logString.includes('Instruction: Create') || 
      logString.includes('InitializeMint') ||
      logString.includes('Create');

    if (!hasCreateInstruction) {
      return; // Pas une création de token
    }

    // Lance l'extraction du Mint depuis la transaction
    // Ne pas await pour ne pas bloquer la boucle d'événements
    this.processTransaction(signature, t_recv).catch(() => {
      // Erreur silencieuse (gestion d'erreurs robuste)
    });
  }

  /**
   * Traite une transaction pour extraire le Mint du nouveau token
   * 
   * Heuristique :
   * - Récupère la transaction avec getTransaction (version 0)
   * - Analyse postTokenBalances pour trouver le Mint avec balance géante
   * - Crée un MarketEvent et émet newLaunch + fastCheck
   * 
   * @param signature - Signature de la transaction
   * @param t_recv - Timestamp de réception locale
   */
  private async processTransaction(signature: string, t_recv: number): Promise<void> {
    try {
      // Récupère la transaction avec maxSupportedTransactionVersion: 0
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed', // 'confirmed' pour avoir les postTokenBalances
      });

      if (!tx || !tx.transaction || !tx.meta) {
        return; // Transaction invalide ou échouée
      }

      // Extraction du Mint depuis postTokenBalances
      const mint = this.extractMintFromTransaction(tx);

      if (!mint) {
        return; // Mint non trouvé
      }

      // Récupère les métadonnées du token
      const tokenMetadata = await this.getTokenMetadata(new PublicKey(mint));

      // Calcule la liquidité initiale (Pump.fun standard: ~30 SOL)
      const liquiditySol = this.calculateInitialLiquidity(tx);

      const t_source: number = tx?.blockTime ? tx.blockTime * 1000 : t_recv;

      // Crée l'événement MarketEvent
      const marketEvent: MarketEvent = {
        token: tokenMetadata,
        poolId: `pump-${signature.slice(0, 8)}`, // ID unique basé sur signature
        initialLiquiditySol: liquiditySol,
        initialPriceUsdc: 0, // Prix initial Pump.fun très faible
        timestamp: t_source,
        t_source,
        t_recv,
      };

      console.log(`[PumpScanner] 🆕 NewLaunch détecté!`);
      console.log(`   Mint: ${mint}`);
      console.log(`   Liquidité: ${liquiditySol.toFixed(2)} SOL`);

      // Émet l'événement newLaunch
      this.emit('newLaunch', marketEvent);

      // Émet fastCheck si liquidité suffisante (Pump.fun = toujours FastCheck)
      if (liquiditySol >= this.fastCheckThreshold) {
        console.log(`[PumpScanner] ⚡ FastCheck activé! (${liquiditySol.toFixed(2)} SOL)`);
        this.emit('fastCheck', marketEvent);
      }
    } catch (error) {
      // Gestion d'erreurs silencieuse (ne pas spammer les logs)
      // Les erreurs RPC sont fréquentes (rate limits, timeout, etc.)
      // On ignore silencieusement pour ne pas crasher la boucle d'événements
    }
  }

  /**
   * Extrait le Mint depuis la transaction Pump.fun
   * 
   * Heuristique :
   * - Analyse postTokenBalances pour trouver le token avec balance géante
   * - Les nouveaux tokens Pump.fun ont souvent une supply initiale énorme (ex: 1B tokens)
   * - Le Mint est celui qui apparaît dans postTokenBalances avec une balance > 0
   * 
   * @param tx - Transaction response
   * @returns Mint address ou null
   */
  private extractMintFromTransaction(tx: any): string | null {
    try {
      const meta = tx.meta;
      if (!meta || !meta.postTokenBalances) {
        return null;
      }

      const postTokenBalances = meta.postTokenBalances;

      if (!postTokenBalances || postTokenBalances.length === 0) {
        return null;
      }

      // Heuristique : trouve le Mint avec la balance la plus élevée
      // Les nouveaux tokens Pump.fun ont souvent une supply initiale énorme
      let maxBalance = BigInt(0);
      let mintAddress: string | null = null;

      for (const balance of postTokenBalances) {
        if (!balance.mint || !balance.uiTokenAmount) {
          continue;
        }

        const amount = BigInt(balance.uiTokenAmount.amount || '0');

        // Si cette balance est plus grande que la précédente, c'est probablement le nouveau token
        if (amount > maxBalance) {
          maxBalance = amount;
          mintAddress = balance.mint;
        }
      }

      // Validation : la balance doit être significative (au moins 1 token)
      if (mintAddress && maxBalance > BigInt(0)) {
        return mintAddress;
      }

      // Fallback : prend le premier Mint trouvé dans postTokenBalances
      const firstBalance = postTokenBalances.find((b: any) => b.mint);
      return firstBalance?.mint || null;
    } catch (error) {
      // Erreur silencieuse
      return null;
    }
  }

  /**
   * Calcule la liquidité initiale depuis la transaction
   * 
   * Pour Pump.fun, la liquidité initiale est généralement ~30 SOL
   * On peut l'estimer depuis les postBalances (SOL déposé)
   * 
   * @param tx - Transaction response
   * @returns Liquidité en SOL
   */
  private calculateInitialLiquidity(tx: any): number {
    try {
      const meta = tx.meta;
      if (!meta || !meta.postBalances) {
        return 30; // Valeur par défaut Pump.fun
      }

      // Heuristique : trouve la balance SOL la plus élevée dans postBalances
      // (c'est généralement le vault Pump.fun)
      const maxBalance = Math.max(...meta.postBalances.map((b: number) => b || 0));

      if (maxBalance > 0) {
        // Convertit lamports en SOL et estime la liquidité
        // Pump.fun utilise généralement ~30 SOL de liquidité initiale
        const solBalance = maxBalance / 1e9;
        return Math.min(solBalance, 100); // Cap à 100 SOL pour éviter les valeurs aberrantes
      }

      return 30; // Valeur par défaut
    } catch (error) {
      return 30; // Valeur par défaut en cas d'erreur
    }
  }

  /**
   * Récupère les métadonnées d'un token
   * 
   * @param mint - PublicKey du mint
   * @returns TokenMetadata
   */
  private async getTokenMetadata(mint: PublicKey): Promise<TokenMetadata> {
    try {
      const mintInfo = await getMint(this.connection, mint);

      // TODO: Intégrer Metaplex pour récupérer le nom/symbol réel
      // Pour l'instant, on retourne des valeurs par défaut
      return {
        mint: mint.toBase58(),
        symbol: 'PUMP',
        name: 'Pump Token',
        decimals: mintInfo.decimals,
      };
    } catch (error) {
      // Erreur silencieuse : retourne des valeurs par défaut
      return {
        mint: mint.toBase58(),
        symbol: 'PUMP',
        name: 'Pump Token',
        decimals: 6, // Défaut Pump.fun
      };
    }
  }

  /**
   * Statistiques pour monitoring
   */
  getStats(): {
    isRunning: boolean;
    processedCount: number;
    cacheSize: number;
  } {
    return {
      isRunning: this.isRunning,
      processedCount: this.processedSignatures.size,
      cacheSize: this.processedSignatures.size,
    };
  }
}
