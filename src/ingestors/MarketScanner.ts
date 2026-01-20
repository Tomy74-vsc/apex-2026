import { Connection, PublicKey, ParsedTransactionWithMeta, VersionedTransactionResponse } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { getMint } from '@solana/spl-token';
import type { MarketEvent, TokenMetadata } from '../types/index.js';

// Raydium AMM v4 Program ID
const RAYDIUM_AMM_V4_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

// SOL mint address
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Instruction discriminator pour initialize2 (Raydium AMM v4)
const INITIALIZE2_DISCRIMINATOR = Buffer.from([0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed]);

/**
 * Événements émis par le MarketScanner
 */
export interface MarketScannerEvents {
  'newToken': (event: MarketEvent) => void;
  'fastCheck': (event: MarketEvent) => void; // Liquidité > 100 SOL
  'error': (error: Error) => void;
  'connected': () => void;
  'disconnected': () => void;
}

/**
 * Options de configuration pour le MarketScanner
 */
export interface MarketScannerOptions {
  rpcUrl?: string;
  wsUrl?: string;
  fastCheckThreshold?: number; // SOL threshold pour FastCheck (défaut: 100)
  cacheSize?: number; // Taille max du cache (défaut: 10000)
  cacheTtlMs?: number; // TTL du cache en ms (défaut: 1 heure)
}

/**
 * Entrée du cache pour éviter les doublons
 */
interface CacheEntry {
  poolId: string;
  timestamp: number;
}

/**
 * MarketScanner - Surveillance temps réel des nouveaux pools Raydium
 * 
 * Utilise WebSocket (onLogs) pour détecter les créations de pools instantanément.
 * Optimisé 2026 : Cache local + FastCheck pour liquidité élevée.
 */
export class MarketScanner extends EventEmitter {
  private connection: Connection;
  private wsConnection: Connection;
  private subscriptionId: number | null = null;
  private processedPools: Map<string, CacheEntry> = new Map();
  private fastCheckThreshold: number;
  private cacheSize: number;
  private cacheTtlMs: number;
  private isRunning: boolean = false;
  private cacheCleanupInterval: Timer | null = null;

  constructor(options: MarketScannerOptions = {}) {
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

    // Connection WebSocket dédiée pour onLogs
    this.wsConnection = new Connection(wsUrl, {
      commitment: 'confirmed',
      wsEndpoint: wsUrl,
    });

    this.fastCheckThreshold = options.fastCheckThreshold || 100; // 100 SOL par défaut
    this.cacheSize = options.cacheSize || 10000;
    this.cacheTtlMs = options.cacheTtlMs || 3600000; // 1 heure par défaut
  }

  /**
   * Démarre la surveillance des logs Raydium
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('⚠️  MarketScanner déjà en cours d\'exécution');
      return;
    }

    try {
      console.log('🚀 Démarrage du MarketScanner...');
      console.log(`📊 Programme surveillé: ${RAYDIUM_AMM_V4_PROGRAM_ID.toBase58()}`);
      console.log(`⚡ FastCheck threshold: ${this.fastCheckThreshold} SOL`);

      // Souscription aux logs du programme Raydium AMM v4
      this.subscriptionId = this.wsConnection.onLogs(
        RAYDIUM_AMM_V4_PROGRAM_ID,
        async (logs, context) => {
          await this.handleLogs(logs, context);
        },
        'confirmed'
      );

      // Démarre le nettoyage périodique du cache
      this.startCacheCleanup();

      this.isRunning = true;
      this.emit('connected');
      console.log('✅ MarketScanner connecté et en écoute\n');
    } catch (error) {
      console.error('❌ Erreur lors du démarrage du MarketScanner:', error);
      this.emit('error', error as Error);
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

    console.log('🛑 Arrêt du MarketScanner...');

    if (this.subscriptionId !== null) {
      await this.wsConnection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
    }

    if (this.cacheCleanupInterval) {
      clearInterval(this.cacheCleanupInterval);
      this.cacheCleanupInterval = null;
    }

    this.isRunning = false;
    this.emit('disconnected');
    console.log('✅ MarketScanner arrêté');
  }

  /**
   * Gère les logs reçus du WebSocket
   */
  private async handleLogs(logs: any, context: any): Promise<void> {
    try {
      const signature = logs.signature;

      // Vérifie si le log contient une instruction initialize2
      const hasInitialize2 = logs.logs?.some((log: string) => 
        log.includes('initialize2') || 
        log.includes('InitializeInstruction2')
      );

      if (!hasInitialize2) {
        return; // Pas une création de pool
      }

      // Vérifie le cache pour éviter le double traitement
      if (this.isPoolProcessed(signature)) {
        return;
      }

      // Marque comme en cours de traitement
      this.markPoolProcessed(signature);

      // Récupère les détails de la transaction
      await this.processNewPool(signature);
    } catch (error) {
      console.error('❌ Erreur lors du traitement des logs:', error);
      this.emit('error', error as Error);
    }
  }

  /**
   * Traite un nouveau pool détecté
   */
  private async processNewPool(signature: string): Promise<void> {
    try {
      // Récupère la transaction avec maxSupportedTransactionVersion: 0
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx || !tx.transaction) {
        console.warn('⚠️  Transaction non trouvée:', signature);
        return;
      }

      // Parse la transaction pour extraire les informations du pool
      const poolInfo = await this.parsePoolTransaction(tx, signature);

      if (!poolInfo) {
        return; // Pas un pool valide
      }

      const { mint, poolId, liquiditySol, priceUsdc, tokenMetadata } = poolInfo;

      // Crée l'événement MarketEvent
      const marketEvent: MarketEvent = {
        token: tokenMetadata,
        poolId,
        initialLiquiditySol: liquiditySol,
        initialPriceUsdc: priceUsdc,
        timestamp: Date.now(),
      };

      console.log(`🆕 Nouveau token détecté!`);
      console.log(`   Mint: ${mint}`);
      console.log(`   Pool: ${poolId}`);
      console.log(`   Liquidité: ${liquiditySol.toFixed(2)} SOL`);
      console.log(`   Prix: $${priceUsdc.toFixed(6)}`);

      // Mode FastCheck : priorité absolue si liquidité > threshold
      if (liquiditySol >= this.fastCheckThreshold) {
        console.log(`⚡ FAST CHECK activé! (${liquiditySol.toFixed(2)} SOL > ${this.fastCheckThreshold} SOL)`);
        this.emit('fastCheck', marketEvent);
      }

      // Émet l'événement standard
      this.emit('newToken', marketEvent);
    } catch (error) {
      console.error('❌ Erreur lors du traitement du pool:', error);
      this.emit('error', error as Error);
    }
  }

  /**
   * Parse une transaction de création de pool pour extraire les informations
   */
  private async parsePoolTransaction(
    tx: VersionedTransactionResponse,
    signature: string
  ): Promise<{
    mint: string;
    poolId: string;
    liquiditySol: number;
    priceUsdc: number;
    tokenMetadata: TokenMetadata;
  } | null> {
    try {
      const { transaction, meta } = tx;

      if (!meta || meta.err) {
        return null; // Transaction échouée
      }

      // Récupère les comptes de la transaction
      const accountKeys = transaction.message.staticAccountKeys || [];
      
      // Dans une transaction initialize2 de Raydium :
      // - Pool state account (nouveau compte créé)
      // - Base mint (token)
      // - Quote mint (SOL ou USDC)
      // - Base vault
      // - Quote vault

      // Trouve le pool ID (premier compte inscriptible créé)
      const poolId = accountKeys[4]?.toBase58() || signature; // Approximation

      // Parse les instructions pour trouver les mints
      let baseMint: PublicKey | null = null;
      let quoteMint: PublicKey | null = null;

      // Les mints sont généralement dans les comptes 5 et 6
      if (accountKeys.length >= 7) {
        baseMint = accountKeys[5];
        quoteMint = accountKeys[6];
      }

      if (!baseMint || !quoteMint) {
        return null;
      }

      // Détermine quel mint est le token (l'autre est SOL/USDC)
      const solMintPubkey = new PublicKey(SOL_MINT);
      let tokenMint: PublicKey;
      let isBaseMintToken: boolean;

      if (quoteMint.equals(solMintPubkey)) {
        tokenMint = baseMint;
        isBaseMintToken = true;
      } else if (baseMint.equals(solMintPubkey)) {
        tokenMint = quoteMint;
        isBaseMintToken = false;
      } else {
        // Pas un pool SOL, on prend le base mint par défaut
        tokenMint = baseMint;
        isBaseMintToken = true;
      }

      // Récupère les métadonnées du token
      const tokenMetadata = await this.getTokenMetadata(tokenMint);

      // Calcule la liquidité initiale en SOL
      const liquiditySol = await this.calculateInitialLiquidity(
        tx,
        accountKeys,
        isBaseMintToken
      );

      // Estime le prix initial (simplifié)
      const priceUsdc = this.estimateInitialPrice(liquiditySol, meta);

      return {
        mint: tokenMint.toBase58(),
        poolId,
        liquiditySol,
        priceUsdc,
        tokenMetadata,
      };
    } catch (error) {
      console.error('❌ Erreur lors du parsing de la transaction:', error);
      return null;
    }
  }

  /**
   * Récupère les métadonnées d'un token
   */
  private async getTokenMetadata(mint: PublicKey): Promise<TokenMetadata> {
    try {
      const mintInfo = await getMint(this.connection, mint);

      // TODO: Intégrer Metaplex pour récupérer le nom/symbol
      // Pour l'instant, on retourne des valeurs par défaut
      return {
        mint: mint.toBase58(),
        symbol: 'UNKNOWN',
        name: 'Unknown Token',
        decimals: mintInfo.decimals,
      };
    } catch (error) {
      console.error('❌ Erreur lors de la récupération des métadonnées:', error);
      return {
        mint: mint.toBase58(),
        symbol: 'UNKNOWN',
        name: 'Unknown Token',
        decimals: 9, // Défaut pour Solana
      };
    }
  }

  /**
   * Calcule la liquidité initiale en SOL depuis les balances post-transaction
   */
  private async calculateInitialLiquidity(
    tx: VersionedTransactionResponse,
    accountKeys: PublicKey[],
    isBaseMintToken: boolean
  ): Promise<number> {
    try {
      const { meta } = tx;

      if (!meta || !meta.postBalances) {
        return 0;
      }

      // Le vault SOL est généralement au compte 8 ou 9
      const solVaultIndex = isBaseMintToken ? 9 : 8;

      if (solVaultIndex < meta.postBalances.length) {
        const solBalance = meta.postBalances[solVaultIndex];
        return solBalance / 1e9; // Lamports vers SOL
      }

      return 0;
    } catch (error) {
      console.error('❌ Erreur lors du calcul de la liquidité:', error);
      return 0;
    }
  }

  /**
   * Estime le prix initial en USDC (simplifié)
   */
  private estimateInitialPrice(liquiditySol: number, meta: any): number {
    // Estimation basique : 1 SOL ≈ $150 (à ajuster avec un oracle prix réel)
    const SOL_PRICE_USD = 150;
    
    // Prix approximatif basé sur la liquidité
    // TODO: Calculer le vrai ratio depuis les balances du pool
    return (liquiditySol * SOL_PRICE_USD) / 1000000; // Prix par token
  }

  /**
   * Vérifie si un pool a déjà été traité (cache)
   */
  private isPoolProcessed(poolId: string): boolean {
    return this.processedPools.has(poolId);
  }

  /**
   * Marque un pool comme traité dans le cache
   */
  private markPoolProcessed(poolId: string): void {
    // Nettoie le cache si trop grand
    if (this.processedPools.size >= this.cacheSize) {
      const oldestKey = this.processedPools.keys().next().value;
      if (oldestKey) {
        this.processedPools.delete(oldestKey);
      }
    }

    this.processedPools.set(poolId, {
      poolId,
      timestamp: Date.now(),
    });
  }

  /**
   * Démarre le nettoyage périodique du cache
   */
  private startCacheCleanup(): void {
    // Nettoie le cache toutes les 5 minutes
    this.cacheCleanupInterval = setInterval(() => {
      this.cleanupCache();
    }, 300000); // 5 minutes
  }

  /**
   * Nettoie les entrées expirées du cache
   */
  private cleanupCache(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.processedPools.entries()) {
      if (now - entry.timestamp > this.cacheTtlMs) {
        this.processedPools.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`🧹 Cache nettoyé: ${cleaned} entrées supprimées (total: ${this.processedPools.size})`);
    }
  }

  /**
   * Statistiques du scanner
   */
  getStats(): {
    isRunning: boolean;
    cacheSize: number;
    uptime: number;
  } {
    return {
      isRunning: this.isRunning,
      cacheSize: this.processedPools.size,
      uptime: this.isRunning ? Date.now() : 0,
    };
  }
}
