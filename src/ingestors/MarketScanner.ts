// DEPRECATED — legacy Raydium snipe path removed; STRATEGY_MODE is curve-prediction only. Kept for scripts/tests reference.
import { Connection, PublicKey } from '@solana/web3.js';
import type { VersionedTransactionResponse } from '@solana/web3.js';
import { EventEmitter } from 'events';
import {
  getMint,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  TokenInvalidAccountSizeError,
} from '@solana/spl-token';
import type { MarketEvent, TokenMetadata } from '../types/index.js';
import type { ClientReadableStream } from '@grpc/grpc-js';

// Raydium AMM v4 Program ID
const RAYDIUM_AMM_V4_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

// SOL mint address
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Adresses système Solana à ignorer — ce ne sont pas des tokens SPL
const SYSTEM_ADDRESSES = new Set([
  '11111111111111111111111111111111', // System Program
  'ComputeBudget111111111111111111111111111111', // Compute Budget
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv', // Associated Token
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', // Metaplex
  SOL_MINT, // Wrapped SOL
  RAYDIUM_AMM_V4_PROGRAM_ID.toBase58(), // Raydium AMM
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJejB', // Serum DEX
]);

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
  geyserEndpoint?: string; // Endpoint gRPC Helius Geyser (host:port)
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
 * Utilise Helius Geyser gRPC pour streamer les transactions non confirmées
 * du programme Raydium AMM v4, et détecter immédiatement les créations de pools.
 * Optimisé 2026 : Cache local + FastCheck pour liquidité élevée, latence cible < 50ms.
 */
export class MarketScanner extends EventEmitter {
  private connection: Connection;
  private geyserEndpoint: string | null;
  private geyserStream: ClientReadableStream<any> | null = null;
  private wsConnection: ReturnType<Connection['onLogs']> | null = null;
  private processedPools: Map<string, CacheEntry> = new Map();
  private fastCheckThreshold: number;
  private cacheSize: number;
  private cacheTtlMs: number;
  private isRunning: boolean = false;
  private cacheCleanupInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectBackoffMs = 1000; // Backoff exponentiel pour reconnexion gRPC
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly BASE_RECONNECT_DELAY_MS = 1000;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MarketScannerOptions = {}) {
    super();
    
    const rpcUrl = options.rpcUrl || process.env.HELIUS_RPC_URL || process.env.RPC_URL;
    const geyserEndpoint = options.geyserEndpoint || process.env.HELIUS_GEYSER_ENDPOINT;

    if (!rpcUrl) {
      throw new Error('RPC URL must be provided via options or HELIUS_RPC_URL env var');
    }

    // Connection pour les requêtes RPC (getTransaction)
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 30000,
    });

    if (!geyserEndpoint) {
      console.warn(
        '[MarketScanner] ⚠️ Aucun endpoint Helius Geyser configuré. ' +
          'Définis HELIUS_GEYSER_ENDPOINT ou passe geyserEndpoint dans MarketScannerOptions.',
      );
      this.geyserEndpoint = null;
    } else {
      this.geyserEndpoint = geyserEndpoint;
    }

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

      // Tentative 1 : Geyser gRPC (ultra-low latency ~10ms) — nécessite Helius pro
      if (this.geyserEndpoint) {
        try {
          await this.startGeyserStream();
          console.log('⚡ [MarketScanner] Geyser gRPC actif (latence ~10ms)');
          this.reconnectAttempts = 0;
        } catch (geyserErr) {
          const msg =
            geyserErr instanceof Error ? geyserErr.message : String(geyserErr);
          if (
            msg.includes('geyser.proto') ||
            msg.includes('ENOENT') ||
            msg.includes('proto')
          ) {
            console.warn(
              '⚠️ [MarketScanner] Geyser indisponible (Free Tier) — fallback onLogs WebSocket',
            );
          } else {
            console.warn(
              `⚠️ [MarketScanner] Geyser erreur: ${msg} — fallback onLogs WebSocket`,
            );
          }
        }
      } else {
        console.warn(
          '⚠️ [MarketScanner] Aucun endpoint Geyser configuré — fallback direct onLogs WebSocket',
        );
      }

      // Tentative 2 : onLogs WebSocket (fallback Free Tier ~200ms)
      if (!this.geyserStream) {
        try {
          this.wsConnection = this.connection.onLogs(
            RAYDIUM_AMM_V4_PROGRAM_ID,
            async (logs) => {
              // ⚡ t_recv : première ligne du callback — avant parsing, avant cache check
              const t_recv = Date.now();
              try {
                const signature = (logs as any).signature as string | undefined;
                if (!signature) return;
                await this.processNewPool(signature, t_recv);
              } catch (err) {
                console.error('❌ [MarketScanner] handleLogs error:', err);
              }
            },
            'processed',
          );
          console.log('✅ [MarketScanner] onLogs WebSocket actif (latence ~200ms)');
          this.reconnectAttempts = 0;
        } catch (wsErr) {
          console.error('❌ [MarketScanner] onLogs failed:', wsErr);
          this.handleReconnect();
        }
      }

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

    this.isRunning = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.geyserStream) {
      this.geyserStream.cancel();
      this.geyserStream = null;
    }

    if (this.wsConnection !== null) {
      try {
        this.connection.removeOnLogsListener(this.wsConnection);
      } catch {
        // ignore detach error
      }
      this.wsConnection = null;
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
   * Gère la reconnexion avec backoff exponentiel pour le fallback WebSocket.
   */
  private handleReconnect(): void {
    if (!this.isRunning) return;
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error(
        `❌ [MarketScanner] Max reconnect attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`,
      );
      this.isRunning = false;
      return;
    }

    const delay = Math.min(
      this.BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      30_000,
    );
    this.reconnectAttempts++;

    console.warn(
      `⚠️ [MarketScanner] WebSocket disconnected. Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})...`,
    );

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(() => {
      this.start().catch((err) => {
        console.error(`❌ [MarketScanner] Reconnect failed:`, err);
        this.handleReconnect();
      });
    }, delay);
  }

  /**
   * Démarre le flux gRPC Helius Geyser et filtre les transactions initialize2 Raydium.
   *
   * L’implémentation gRPC exacte dépend du proto Helius (geyser.proto).
   * Ici, on charge dynamiquement le proto via @grpc/proto-loader et on
   * s’abonne au flux de transactions exécutées.
   */
  private async startGeyserStream(): Promise<void> {
    if (!this.geyserEndpoint) {
      throw new Error('HELIUS_GEYSER_ENDPOINT non défini');
    }

    const protoPath =
      process.env.HELIUS_GEYSER_PROTO_PATH || 'proto/geyser.proto';

    try {
      const [{ loadSync }, grpc] = await Promise.all([
        import('@grpc/proto-loader'),
        import('@grpc/grpc-js'),
      ]);

      const packageDef = loadSync(protoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      });

      const proto = (grpc.loadPackageDefinition(packageDef) as any)
        .solana?.geyser?.v1;

      if (!proto || !proto.Geyser) {
        throw new Error(
          'Impossible de charger le service Geyser depuis le proto (vérifie HELIUS_GEYSER_PROTO_PATH).',
        );
      }

      const client = new proto.Geyser(
        this.geyserEndpoint,
        grpc.credentials.createSsl(),
      );

      // La structure exacte de la requête dépend du proto.
      // Ici, on suppose une méthode Subscribe ou similar avec un filtre programme.
      const request = {
        // TODO: Adapter au schéma Helius Geyser (par ex. filter sur programme Raydium)
        // program: RAYDIUM_AMM_V4_PROGRAM_ID.toBase58(),
      };

      console.log(
        `[MarketScanner] 🛰 Connexion au flux Geyser Helius sur ${this.geyserEndpoint}...`,
      );

      const stream: ClientReadableStream<any> = client.Subscribe(request);
      this.geyserStream = stream;
      this.reconnectBackoffMs = 1000; // Reset backoff à chaque connexion réussie

      stream.on('data', async (msg: any) => {
        try {
          await this.handleGeyserMessage(msg);
        } catch (error) {
          console.error(
            '[MarketScanner] ❌ Erreur lors du traitement d’un message Geyser:',
            error,
          );
          this.emit('error', error as Error);
        }
      });

      stream.on('error', (err: any) => {
        console.error('[MarketScanner] ❌ Erreur flux Geyser:', err);
        this.emit('error', err as Error);
        this.scheduleReconnect();
      });

      stream.on('end', () => {
        console.warn('[MarketScanner] ⚠️ Flux Geyser terminé.');
        this.scheduleReconnect();
      });

      console.log('[MarketScanner] ✅ Connecté au flux Geyser Helius');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // Cas Free Tier / proto manquant : on laisse le fallback onLogs gérer
      if (
        msg.includes('geyser.proto') ||
        msg.includes('ENOENT') ||
        msg.includes('proto')
      ) {
        throw error;
      }

      console.error('[MarketScanner] ❌ Impossible de démarrer le flux Geyser:', error);
      this.emit('error', error as Error);
      this.scheduleReconnect();
    }
  }

  /**
   * Gestion des messages reçus depuis le flux Geyser.
   *
   * On filtre les transactions contenant une instruction initialize2
   * du programme Raydium AMM v4, puis on déclenche le pipeline existant
   * (cache + processNewPool).
   */
  private async handleGeyserMessage(message: any): Promise<void> {
    // La structure exacte de `message` dépend du proto. On suppose ici
    // qu’il contient un champ transaction avec meta.logMessages et signatures.
    const txInfo = message?.transaction || message?.tx || null;
    if (!txInfo) {
      return;
    }

    const meta = txInfo.meta || txInfo.transactionMeta || null;
    const logs: string[] =
      meta?.logMessages || meta?.log_messages || meta?.logs || [];

    if (!logs || logs.length === 0) {
      return;
    }

    // Vérifie si le log contient une instruction initialize2
    const hasInitialize2 = logs.some(
      (log: string) =>
        log.includes('initialize2') || log.includes('InitializeInstruction2'),
    );

    if (!hasInitialize2) {
      return; // Pas une création de pool
    }

    // Récupère la signature de la transaction
    const signature: string | undefined =
      txInfo.signature ||
      txInfo.signatures?.[0] ||
      meta?.transactionSignature ||
      undefined;

    if (!signature) {
      return;
    }

    // Vérifie le cache pour éviter le double traitement
    if (this.isPoolProcessed(signature)) {
      return;
    }

    // Marque comme en cours de traitement
    this.markPoolProcessed(signature);

    // Récupère les détails de la transaction via RPC (faible coût, 1 requête)
    const t_recv = Date.now();
    await this.processNewPool(signature, t_recv);
  }

  /**
   * Planifie une reconnexion au flux Geyser avec backoff exponentiel.
   */
  private scheduleReconnect(): void {
    if (!this.isRunning) {
      return;
    }

    const delay = this.reconnectBackoffMs;
    this.reconnectBackoffMs = Math.min(this.reconnectBackoffMs * 2, 30000); // Max 30s

    console.log(
      `[MarketScanner] 🔁 Reconnexion au flux Geyser dans ${delay}ms...`,
    );

    setTimeout(() => {
      if (!this.isRunning) return;
      this.startGeyserStream().catch((err) => {
        console.error(
          '[MarketScanner] ❌ Erreur lors de la reconnexion Geyser:',
          err,
        );
      });
    }, delay);
  }

  /**
   * Traite un nouveau pool détecté
   */
  private async processNewPool(signature: string, t_recv: number): Promise<void> {
    try {
      // Récupère la transaction avec maxSupportedTransactionVersion: 0
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx || !tx.transaction) {
        return;
      }

      // Parse la transaction pour extraire les informations du pool
      const poolInfo = await this.parsePoolTransaction(tx, signature);

      if (!poolInfo) {
        return; // Pas un pool valide
      }

      const { mint, poolId, liquiditySol, priceUsdc, tokenMetadata } = poolInfo;

      // Récupère t_source depuis blockTime Solana si disponible
      // blockTime est en secondes Unix → convertir en ms
      const t_source: number = tx?.blockTime ? tx.blockTime * 1000 : t_recv;

      // Crée l'événement MarketEvent
      const marketEvent: MarketEvent = {
        token: tokenMetadata,
        poolId,
        initialLiquiditySol: liquiditySol,
        initialPriceUsdc: priceUsdc,
        timestamp: t_source, // compatibilité — = t_source
        t_source,
        t_recv,
        // t_act non défini ici — sera rempli par DecisionCore
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
        baseMint = accountKeys[5] || null;
        quoteMint = accountKeys[6] || null;
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

      // Filtre les mints système connus (Program IDs, wrapped SOL, etc.)
      const mintBase58 = tokenMint.toBase58();
      if (SYSTEM_ADDRESSES.has(mintBase58)) {
        return null;
      }

      // Validation longueur base58 minimale pour un mint SPL
      if (mintBase58.length < 32 || mintBase58.length > 44) {
        return null;
      }

      // Récupère les métadonnées du token
      const tokenMetadata = await this.getTokenMetadata(tokenMint);
      if (tokenMetadata === null) {
        // Token-2022 ou mint invalide → on rejette silencieusement le pool
        return null;
      }

      // Calcule la liquidité initiale en SOL
      const liquiditySol = await this.calculateInitialLiquidity(
        tx,
        accountKeys,
        isBaseMintToken
      );

      // Estime le prix initial (simplifié)
      const priceUsdc = this.estimateInitialPrice(liquiditySol, meta);

      return {
        mint: mintBase58,
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
  private async getTokenMetadata(mint: PublicKey): Promise<TokenMetadata | null> {
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
      // Token-2022, non-SPL ou toute autre erreur (réseau, RPC, etc.)
      // → on rejette silencieusement ce mint pour ne jamais le faire entrer dans le pipeline.
      if (
        error instanceof TokenInvalidAccountSizeError ||
        error instanceof TokenInvalidAccountOwnerError ||
        error instanceof TokenAccountNotFoundError
      ) {
        return null;
      }
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(
        `⚠️ [MarketScanner] Métadonnées invalides pour ${mint
          .toBase58()
          .slice(0, 8)}: ${msg}`,
      );
      return null;
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
        if (solBalance !== undefined) {
          return solBalance / 1e9; // Lamports vers SOL
        }
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
