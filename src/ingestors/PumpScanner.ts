import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import type { MarketEvent, TokenMetadata } from '../types/index.js';

/**
 * Événements émis par le PumpScanner
 */
export interface PumpScannerEvents {
  'newLaunch': (event: MarketEvent) => void;
  'migrationPending': (event: MarketEvent) => void;
  'fastCheck': (event: MarketEvent) => void;
  'error': (error: Error) => void;
  'connected': () => void;
  'disconnected': () => void;
}

/**
 * Options de configuration pour le PumpScanner
 */
export interface PumpScannerOptions {
  rpcUrl?: string;
  geyserEndpoint?: string; // Endpoint gRPC Helius Geyser (host:port)
  fastCheckThresholdSol?: number; // Seuil de liquidité pour FastCheck (défaut: 50 SOL)
}

/**
 * PumpScanner - Surveillance des tokens Pump.fun via Helius Geyser
 *
 * Objectifs:
 * - Détecter les nouveaux lancements directement sur la bonding curve (NewLaunch)
 * - Détecter les migrations imminentes vers Raydium (MigrationPending, 100% sold)
 * - Émettre des événements compatibles avec le DecisionCore (FastCheck -> MarketEvent)
 *
 * Note importante:
 * - L'intégration gRPC Helius Geyser nécessite les définitions protobuf officielles.
 * - Ce module expose une API et une structure d'événements prête pour cette intégration.
 * - La méthode privée `startGeyserStream` contient un TODO explicite pour brancher le client gRPC.
 */
export class PumpScanner extends EventEmitter {
  private readonly fastCheckThresholdSol: number;
  private readonly geyserEndpoint: string | null;
  private readonly programId: PublicKey | null;
  private readonly connection: Connection;
  private isRunning = false;

  constructor(options: PumpScannerOptions = {}) {
    super();

    const rpcUrl = options.rpcUrl || process.env.HELIUS_RPC_URL || process.env.RPC_URL;
    if (!rpcUrl) {
      throw new Error('RPC URL must be provided via options or HELIUS_RPC_URL / RPC_URL env var');
    }

    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 30000,
    });

    this.fastCheckThresholdSol = options.fastCheckThresholdSol ?? 50; // 50 SOL par défaut
    this.geyserEndpoint = options.geyserEndpoint || process.env.HELIUS_GEYSER_ENDPOINT || null;

    // Le programme Pump.fun doit être fourni via une variable d'environnement
    const pumpProgramId = process.env.PUMPFUN_PROGRAM_ID;
    this.programId = pumpProgramId ? new PublicKey(pumpProgramId) : null;

    if (!this.geyserEndpoint) {
      console.warn('[PumpScanner] ⚠️ Aucun endpoint Helius Geyser configuré (HELIUS_GEYSER_ENDPOINT).');
    }
    if (!this.programId) {
      console.warn('[PumpScanner] ⚠️ Aucun PUMPFUN_PROGRAM_ID défini. Les filtres précis ne seront pas appliqués.');
    }
  }

  /**
   * Démarre la surveillance Pump.fun
   *
   * En production:
   * - Connecte au flux gRPC Helius Geyser (slot-updated / transactions)
   * - Filtre sur le programme Pump.fun
   * - Parse les instructions pour détecter:
   *   - NewLaunch (création de bonding curve)
   *   - MigrationPending (100% sold, migration Raydium imminente)
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('[PumpScanner] ⚠️ Déjà en cours d’exécution');
      return;
    }

    this.isRunning = true;

    try {
      console.log('[PumpScanner] 🚀 Démarrage du PumpScanner...');

      // TODO: Brancher ici le client gRPC Helius Geyser
      // - Utiliser les proto officiels Helius (geyser.proto)
      // - Streamer les transactions filtrées sur le programme Pump.fun
      // - Appeler this.handleNewLaunch(...) et this.handleMigrationPending(...) selon le type d’instruction
      this.startGeyserStreamPlaceholder();

      this.emit('connected');
      console.log('[PumpScanner] ✅ PumpScanner démarré (mode placeholder, gRPC à intégrer)');
    } catch (error) {
      console.error('[PumpScanner] ❌ Erreur lors du démarrage:', error);
      this.emit('error', error as Error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Arrête la surveillance Pump.fun
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log('[PumpScanner] 🛑 Arrêt en cours...');
    // Lorsque l’intégration gRPC sera en place, fermer ici le stream / client

    this.isRunning = false;
    this.emit('disconnected');
    console.log('[PumpScanner] ✅ Arrêté');
  }

  /**
   * Gestion d’un nouvel événement NewLaunch (création sur bonding curve Pump.fun)
   *
   * @param mint       Mint du token Pump.fun
   * @param poolId    Identifiant logique (ex: bonding curve / pool virtuel)
   * @param liquiditySol Liquidité initiale sur la bonding curve (en SOL)
   */
  private async handleNewLaunch(
    mint: string,
    poolId: string,
    liquiditySol: number,
  ): Promise<void> {
    try {
      const tokenMetadata = await this.getTokenMetadata(new PublicKey(mint));

      const event: MarketEvent = {
        token: tokenMetadata,
        poolId,
        initialLiquiditySol: liquiditySol,
        // Pour Pump.fun, le prix initial est souvent très faible, estimation simplifiée
        initialPriceUsdc: 0,
        timestamp: Date.now(),
      };

      console.log('[PumpScanner] 🆕 NewLaunch détecté:', mint);
      this.emit('newLaunch', event);

      // Si la liquidité dépasse un certain seuil, on peut déjà pré-marquer en fast track
      if (liquiditySol >= this.fastCheckThresholdSol) {
        console.log(
          `[PumpScanner] ⚡ FastCheck (NewLaunch, ${liquiditySol.toFixed(
            2,
          )} SOL ≥ ${this.fastCheckThresholdSol} SOL)`,
        );
        this.emit('fastCheck', event);
      }
    } catch (error) {
      console.error('[PumpScanner] ❌ Erreur handleNewLaunch:', error);
      this.emit('error', error as Error);
    }
  }

  /**
   * Gestion d’un événement MigrationPending
   *
   * Un token Pump.fun a atteint 100% de la bonding curve et va migrer sur Raydium.
   * C’est généralement un bon signal de potentiel → FastCheck immédiat.
   *
   * @param mint               Mint du token Pump.fun
   * @param poolId            Identifiant (bonding curve)
   * @param finalLiquiditySol Liquidité finale accumulée sur la bonding curve
   */
  private async handleMigrationPending(
    mint: string,
    poolId: string,
    finalLiquiditySol: number,
  ): Promise<void> {
    try {
      const tokenMetadata = await this.getTokenMetadata(new PublicKey(mint));

      const event: MarketEvent = {
        token: tokenMetadata,
        poolId,
        initialLiquiditySol: finalLiquiditySol,
        initialPriceUsdc: 0,
        timestamp: Date.now(),
      };

      console.log('[PumpScanner] 🚚 MigrationPending détecté:', mint);
      this.emit('migrationPending', event);

      // MigrationPending implique généralement un fort intérêt → FastCheck systématique
      console.log('[PumpScanner] ⚡ FastCheck (MigrationPending)');
      this.emit('fastCheck', event);
    } catch (error) {
      console.error('[PumpScanner] ❌ Erreur handleMigrationPending:', error);
      this.emit('error', error as Error);
    }
  }

  /**
   * Récupère des métadonnées basiques pour un token Pump.fun
   *
   * Pour rester ultra-rapide, on ne fait qu’un minimum ici. Metaplex pourra
   * être branché plus tard pour un enrichissement (nom, symbol réels, etc.).
   */
  private async getTokenMetadata(mint: PublicKey): Promise<TokenMetadata> {
    // TODO: Optionnellement, interroger Metaplex ou un indexeur pour nom/symbol réels.
    return {
      mint: mint.toBase58(),
      symbol: 'PUMP',
      name: 'Pump Token',
      decimals: 9,
    };
  }

  /**
   * Placeholder pour le flux gRPC Helius Geyser.
   *
   * Cette méthode doit être remplacée par une implémentation réelle utilisant
   * les proto Helius (geyser.proto) et @grpc/grpc-js, par exemple.
   *
   * L’objectif ici est de définir clairement où intégrer la logique temps réel,
   * tout en gardant le module utilisable (API stable) pour le reste du codebase.
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private startGeyserStreamPlaceholder(): void {
    console.log(
      '[PumpScanner] ℹ️ startGeyserStreamPlaceholder appelé. ' +
        'Intégration gRPC Helius Geyser à implémenter (voir commentaires dans PumpScanner.ts).',
    );
  }

  /**
   * Statistiques de base (pour futur dashboard, si besoin)
   */
  getStats(): {
    isRunning: boolean;
    fastCheckThresholdSol: number;
    geyserEndpoint: string | null;
  } {
    return {
      isRunning: this.isRunning,
      fastCheckThresholdSol: this.fastCheckThresholdSol,
      geyserEndpoint: this.geyserEndpoint,
    };
  }
}

