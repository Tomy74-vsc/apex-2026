import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { getMint } from '@solana/spl-token';
import WS from 'ws';

/** Payload `ws` `message` (aligné sur @types/ws sans dépendre de RawData exporté). */
type WsMessagePayload = string | Buffer | ArrayBuffer | Buffer[];
import type { MarketEvent, TokenMetadata } from '../types/index.js';
import { getCurveTracker } from '../modules/curve-tracker/CurveTracker.js';
import { fetchDexSolanaTokenMeta } from './dexPumpMeta.js';
import { getNarrativeRadar, type NarrativeSignal } from '../social/NarrativeRadar.js';
import { KOTH_SOL_THRESHOLD } from '../constants/pumpfun.js';
import { deriveBondingCurvePDA, decodeBondingCurve, type BondingCurveState } from '../types/bonding-curve.js';
import { calcProgress } from '../math/curve-math.js';

/**
 * PumpScanner - Surveillance temps réel des nouveaux tokens Pump.fun
 * 
 * Uses raw `ws` package for WebSocket subscriptions (Bun's native WebSocket
 * fails the HTTP 101 upgrade with Solana RPC endpoints due to compression
 * negotiation issues). The `@solana/web3.js` Connection is kept for RPC calls only.
 */

import { PUMP_PROGRAM_ID } from '../constants/pumpfun.js';

const LAMPORTS_PER_SOL_N = 1_000_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  private ws: WS | null = null;
  private wsSubId: number | null = null;
  private processedSignatures: Set<string> = new Set();
  private isRunning: boolean = false;
  private fastCheckThreshold: number;
  private readonly MAX_CACHE_SIZE = 1000;

  private readonly isCurveMode: boolean;
  private readonly minRegistrationSOL: number;
  private readonly maxGetTxRetries: number;

  private registeredMints: Set<string> = new Set();
  private readonly MAX_MINT_CACHE = 500;

  private readonly rpcUrl: string;
  private readonly wsEndpoints: string[];
  private activeWsIndex = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly RECONNECT_DELAY_MS = 5_000;
  private readonly HEALTH_CHECK_INTERVAL_MS = 15_000;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastEventTs = 0;
  private rpcIdCounter = 1;

  private statsInternal = {
    txNotFound: 0,
    filteredLowSOL: 0,
    filteredLateStage: 0,
    registeredCurves: 0,
    curveCheckFailed: 0,
    duplicateMints: 0,
    wsReconnects: 0,
  };

  constructor(options: PumpScannerOptions = {}) {
    super();

    this.isCurveMode = process.env.STRATEGY_MODE === 'curve-prediction';
    this.minRegistrationSOL = parseFloat(process.env.MIN_CURVE_REGISTRATION_SOL || '1.5');
    this.maxGetTxRetries = this.isCurveMode ? 2 : 0;

    this.rpcUrl = options.rpcUrl || process.env.HELIUS_RPC_URL || process.env.RPC_URL || '';
    const heliusWs = options.wsUrl || process.env.HELIUS_WS_URL || this.rpcUrl.replace('https://', 'wss://');
    const publicWs = 'wss://api.mainnet-beta.solana.com';

    this.wsEndpoints = [publicWs, heliusWs].filter(Boolean);

    if (!this.rpcUrl) {
      throw new Error('RPC URL must be provided via options or HELIUS_RPC_URL env var');
    }

    this.connection = new Connection(this.rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 30000,
    });

    this.fastCheckThreshold = options.fastCheckThreshold || 30;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('[PumpScanner] ⚠️ Deja en cours d\'execution');
      return;
    }

    const commitment = this.isCurveMode ? 'confirmed' : 'processed';
    console.log('[PumpScanner] 🚀 Demarrage...');
    console.log(`📊 Programme surveille: ${PUMP_PROGRAM_ID.toBase58()}`);
    console.log(`⚡ Mode: ${this.isCurveMode ? 'curve-prediction' : 'legacy'}`);
    console.log(`⚡ Commitment: ${commitment}`);
    console.log(`🌐 WS endpoints: ${this.wsEndpoints.length} (primary: ${this.wsEndpoints[0]?.slice(0, 40)}...)`);
    if (this.isCurveMode) {
      console.log(`🔍 Min registration SOL: ${this.minRegistrationSOL}`);
    } else {
      console.log(`⚡ FastCheck threshold: ${this.fastCheckThreshold} SOL`);
    }

    this.isRunning = true;
    this.lastEventTs = Date.now();
    this.connectWs();

    this.healthCheckTimer = setInterval(() => this.checkHealth(), this.HEALTH_CHECK_INTERVAL_MS);
  }

  private connectWs(): void {
    const wsUrl = this.wsEndpoints[this.activeWsIndex] ?? this.wsEndpoints[0]!;

    try {
      if (this.ws) {
        try { this.ws.terminate(); } catch {}
        this.ws = null;
      }

      this.ws = new WS(wsUrl, { perMessageDeflate: false, handshakeTimeout: 10_000 });

      this.ws.on('open', () => {
        console.log(`[PumpScanner] ✅ WS connected: ${wsUrl.slice(0, 50)}`);
        const commitment = this.isCurveMode ? 'confirmed' : 'processed';
        const subId = this.rpcIdCounter++;
        this.ws!.send(JSON.stringify({
          jsonrpc: '2.0',
          id: subId,
          method: 'logsSubscribe',
          params: [
            { mentions: [PUMP_PROGRAM_ID.toBase58()] },
            { commitment },
          ],
        }));
        this.lastEventTs = Date.now();
        this.emit('connected');
      });

      this.ws.on('message', (raw: WsMessagePayload) => {
        try {
          this.lastEventTs = Date.now();
          const msg = JSON.parse(raw.toString());

          if (msg.result !== undefined && !msg.method) {
            this.wsSubId = msg.result;
            return;
          }

          if (msg.method === 'logsNotification') {
            const result = msg.params?.result;
            const value = result?.value;
            if (!value) return;
            const logs = {
              signature: value.signature as string,
              err: value.err,
              logs: value.logs as string[],
            };
            const context = { slot: result?.context?.slot ?? 0 };
            this.handleLogs(logs, context).catch(() => {});
          }
        } catch {}
      });

      this.ws.on('close', () => {
        console.warn(`⚠️  [PumpScanner] WS closed — scheduling reconnect`);
        this.scheduleReconnect();
      });

      this.ws.on('error', (err: Error) => {
        console.warn(`⚠️  [PumpScanner] WS error: ${err.message?.slice(0, 80)}`);
      });
    } catch (err) {
      console.error(`❌ [PumpScanner] WS connect failed:`, err);
      this.scheduleReconnect();
    }
  }

  private checkHealth(): void {
    if (!this.isRunning) return;
    const silenceSec = (Date.now() - this.lastEventTs) / 1_000;
    if (silenceSec > 60) {
      console.warn(`⚠️  [PumpScanner] No WS events for ${silenceSec.toFixed(0)}s — reconnecting...`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.isRunning) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isRunning) return;

      this.activeWsIndex = (this.activeWsIndex + 1) % this.wsEndpoints.length;
      this.statsInternal.wsReconnects++;
      console.log(`🔄 [PumpScanner] Reconnecting to WS #${this.activeWsIndex} (${this.wsEndpoints[this.activeWsIndex]?.slice(0, 40)}...)`);
      this.connectWs();
    }, this.RECONNECT_DELAY_MS);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log('[PumpScanner] 🛑 Arret en cours...');
    this.isRunning = false;

    if (this.healthCheckTimer) { clearInterval(this.healthCheckTimer); this.healthCheckTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }

    if (this.ws) {
      if (this.wsSubId !== null) {
        try {
          this.ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: this.rpcIdCounter++,
            method: 'logsUnsubscribe',
            params: [this.wsSubId],
          }));
        } catch {}
      }
      try { this.ws.terminate(); } catch {}
      this.ws = null;
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

    const logLines: string[] = logs.logs ?? [];
    const hasCreateInstruction = logLines.some(
      (line: string) =>
        line.includes('Instruction: Create') ||
        line.includes('InitializeMint2'),
    );

    if (!hasCreateInstruction) {
      return;
    }

    // Lance l'extraction du Mint depuis la transaction
    // Ne pas await pour ne pas bloquer la boucle d'événements
    this.processTransaction(signature, t_recv).catch(() => {
      // Erreur silencieuse (gestion d'erreurs robuste)
    });
  }

  private async processTransaction(signature: string, t_recv: number): Promise<void> {
    try {
      const tx = await this.getTransactionWithRetry(signature);

      if (!tx || !tx.transaction || !tx.meta) {
        return;
      }

      const mint = this.extractMintFromTransaction(tx);
      if (!mint) return;

      const t_source: number = tx?.blockTime ? tx.blockTime * 1000 : t_recv;

      if (this.isCurveMode) {
        await this.processCurveMode(mint, tx, signature, t_source, t_recv);
      } else {
        await this.processLegacyMode(mint, tx, signature, t_source, t_recv);
      }
    } catch {
      // silent — RPC errors are frequent
    }
  }

  /**
   * getTransaction with configurable retry + delay for curve-prediction mode.
   * In legacy mode: single attempt, no delay. In curve mode: up to maxGetTxRetries.
   */
  private async getTransactionWithRetry(signature: string): Promise<any> {
    for (let attempt = 0; attempt <= this.maxGetTxRetries; attempt++) {
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (tx?.transaction && tx.meta) return tx;

      if (attempt < this.maxGetTxRetries) {
        await sleep(1500);
      } else {
        this.statsInternal.txNotFound++;
      }
    }
    return null;
  }

  /**
   * curve-prediction pipeline: fetch bonding curve state on-chain,
   * filter tokens with insufficient SOL, only then register in CurveTracker.
   */
  private async processCurveMode(
    mint: string,
    tx: any,
    signature: string,
    t_source: number,
    t_recv: number,
  ): Promise<void> {
    if (this.registeredMints.has(mint)) {
      this.statsInternal.duplicateMints++;
      return;
    }

    const mintPk = new PublicKey(mint);
    const [curvePDA] = deriveBondingCurvePDA(mintPk);

    let realSolSOL = 0;
    let progress = 0;
    let curveComplete = false;
    let decodedState: BondingCurveState | undefined;

    try {
      const acctInfo = await this.connection.getAccountInfo(curvePDA);
      if (acctInfo?.data) {
        decodedState = decodeBondingCurve(acctInfo.data as Buffer);
        realSolSOL = Number(decodedState.realSolReserves) / LAMPORTS_PER_SOL_N;
        progress = calcProgress(decodedState.realTokenReserves);
        curveComplete = decodedState.complete;
      }
    } catch {
      this.statsInternal.curveCheckFailed++;
    }

    if (curveComplete) return;
    if (realSolSOL < this.minRegistrationSOL) {
      this.statsInternal.filteredLowSOL++;
      return;
    }
    if (progress > 0.80) {
      this.statsInternal.filteredLateStage++;
      return;
    }

    let tokenMetadata: TokenMetadata = { mint, symbol: 'PUMP', name: 'Pump Token', decimals: 6 };
    const dexMeta = await fetchDexSolanaTokenMeta(mint).catch(() => null);
    if (dexMeta) {
      tokenMetadata = { ...tokenMetadata, name: dexMeta.name, symbol: dexMeta.symbol };
    }
    const creatorAddress = this.extractCreatorFromTransaction(tx);

    if (this.registeredMints.size >= this.MAX_MINT_CACHE) {
      const oldest = Array.from(this.registeredMints).slice(0, 250);
      oldest.forEach((m) => this.registeredMints.delete(m));
    }
    this.registeredMints.add(mint);

    const radar = getNarrativeRadar();
    let watchlistHit: NarrativeSignal | null = null;
    try {
      watchlistHit = radar.takeWatchlistMatchForNewMint(tokenMetadata.name, tokenMetadata.symbol);
    } catch {
      watchlistHit = null;
    }

    const curveTracker = getCurveTracker();
    curveTracker.registerNewCurve(
      mint,
      creatorAddress,
      { name: tokenMetadata.name, symbol: tokenMetadata.symbol },
      decodedState,
      { fromNarrativeWatchlist: watchlistHit != null },
    );

    if (!watchlistHit) {
      try {
        const activeNarr = radar.matchesToken(tokenMetadata.name, tokenMetadata.symbol);
        if (activeNarr) {
          curveTracker.forcePromoteHot(mint);
          console.log(
            `📡 [NarrativeRadar] Étape 2 — nouveau mint HOT ← narratif actif "${activeNarr.theme}"`,
          );
        }
      } catch {
        /* cold path */
      }
    }
    this.statsInternal.registeredCurves++;

    console.log(
      `[PumpScanner] 🆕 Curve enregistrée: ${mint.slice(0, 8)}... | ` +
      `${tokenMetadata.symbol} "${tokenMetadata.name.slice(0, 24)}${tokenMetadata.name.length > 24 ? '…' : ''}" | ` +
      `${realSolSOL.toFixed(2)} SOL | progress ${(progress * 100).toFixed(1)}%` +
      (watchlistHit ? ' | 📋 narrative watchlist → WARM' : ''),
    );

    const marketEvent: MarketEvent = {
      token: tokenMetadata,
      poolId: `pump-${signature.slice(0, 8)}`,
      initialLiquiditySol: realSolSOL,
      initialPriceUsdc: 0,
      timestamp: t_source,
      t_source,
      t_recv,
    };
    this.emit('newLaunch', marketEvent);

    if (realSolSOL >= KOTH_SOL_THRESHOLD) {
      curveTracker.forcePromoteHot(mint);
    }
  }

  /**
   * Legacy snipe-at-T=0 pipeline: no bonding curve check, max speed.
   */
  private async processLegacyMode(
    mint: string,
    tx: any,
    signature: string,
    t_source: number,
    t_recv: number,
  ): Promise<void> {
    const tokenMetadata = await this.getTokenMetadata(new PublicKey(mint));
    const liquiditySol = this.calculateInitialLiquidity(tx);

    const marketEvent: MarketEvent = {
      token: tokenMetadata,
      poolId: `pump-${signature.slice(0, 8)}`,
      initialLiquiditySol: liquiditySol,
      initialPriceUsdc: 0,
      timestamp: t_source,
      t_source,
      t_recv,
    };

    console.log(`🆕 Nouveau token détecté!`);
    console.log(`   Mint: ${mint}`);
    console.log(`   Liquidité: ${liquiditySol.toFixed(2)} SOL`);

    this.emit('newLaunch', marketEvent);

    if (liquiditySol >= this.fastCheckThreshold) {
      console.log(`⚡ FastCheck activé! (${liquiditySol.toFixed(2)} SOL)`);
      this.emit('fastCheck', marketEvent);
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
   * Extrait l'adresse du createur depuis la transaction Pump.fun.
   * Heuristique: le premier signer (fee payer) est generalement le createur.
   */
  private extractCreatorFromTransaction(tx: any): string {
    try {
      const keys = tx?.transaction?.message?.accountKeys;
      if (Array.isArray(keys) && keys.length > 0) {
        const first = keys[0];
        if (typeof first === 'string') return first;
        if (first?.pubkey) return first.pubkey.toBase58?.() ?? String(first.pubkey);
        return String(first);
      }
      const staticKeys = tx?.transaction?.message?.staticAccountKeys;
      if (Array.isArray(staticKeys) && staticKeys.length > 0) {
        return staticKeys[0].toBase58?.() ?? String(staticKeys[0]);
      }
    } catch { /* silent */ }
    return PublicKey.default.toBase58();
  }

  getStats(): {
    isRunning: boolean;
    processedCount: number;
    cacheSize: number;
    txNotFound: number;
    filteredLowSOL: number;
    filteredLateStage: number;
    registeredCurves: number;
    curveCheckFailed: number;
    wsReconnects: number;
    mode: string;
    minRegistrationSOL: number;
    activeWsEndpoint: string;
  } {
    return {
      isRunning: this.isRunning,
      processedCount: this.processedSignatures.size,
      cacheSize: this.processedSignatures.size,
      ...this.statsInternal,
      mode: this.isCurveMode ? 'curve-prediction' : 'legacy',
      minRegistrationSOL: this.minRegistrationSOL,
      activeWsEndpoint: this.wsEndpoints[this.activeWsIndex]?.slice(0, 40) ?? 'none',
    };
  }
}
