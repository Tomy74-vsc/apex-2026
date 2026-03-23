import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { TieredMonitor } from './TieredMonitor.js';
import { deriveBondingCurvePDA } from '../../types/bonding-curve.js';
import type { TrackedCurve, CurveTradeEvent, BondingCurveState } from '../../types/bonding-curve.js';
import type { CurveEvictionSnapshot } from './TieredMonitor.js';

const MAX_TRADE_HISTORY = 500;

let instance: CurveTracker | null = null;

export function getCurveTracker(): CurveTracker {
  if (!instance) {
    instance = new CurveTracker();
  }
  return instance;
}

export class CurveTracker extends EventEmitter {
  private tieredMonitor: TieredMonitor | null = null;
  private readonly tradeHistory: Map<string, CurveTradeEvent[]> = new Map();
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;

    const connections = this.buildConnections();
    this.tieredMonitor = new TieredMonitor(connections);

    this.tieredMonitor.on('enterHotZone', (mint: string, curve: TrackedCurve) => {
      this.emit('enterHotZone', mint, curve);
    });
    this.tieredMonitor.on('enterWarmZone', (mint: string, curve: TrackedCurve) => {
      this.emit('enterWarmZone', mint, curve);
    });
    this.tieredMonitor.on('curveUpdate', (mint: string, curve: TrackedCurve) => {
      this.emit('curveUpdate', mint, curve);
    });
    this.tieredMonitor.on('graduated', (mint: string, curve: TrackedCurve) => {
      this.emit('graduated', mint, curve);
      this.tradeHistory.delete(mint);
    });
    this.tieredMonitor.on('evicted', (mint: string, reason: string, snap?: CurveEvictionSnapshot) => {
      this.emit('evicted', mint, reason, snap);
      this.tradeHistory.delete(mint);
    });

    /** Microstructure / vélocité : flux SOL agrégés entre polls (pas de wallet on-chain ici). */
    this.tieredMonitor.on('syntheticTrade', (e: CurveTradeEvent) => {
      try {
        this.recordTrade(e);
      } catch {
        /* cold path */
      }
    });

    this.tieredMonitor.start();
    this.started = true;
    console.log('🚀 [CurveTracker] Started — monitoring bonding curves');
  }

  registerNewCurve(
    mint: string,
    creator: string,
    metadata?: { name?: string; symbol?: string; uri?: string },
    initialState?: BondingCurveState,
    options?: { fromNarrativeWatchlist?: boolean },
  ): void {
    if (!this.tieredMonitor) return;

    const mintPk = new PublicKey(mint);
    const [bondingCurvePDA] = deriveBondingCurvePDA(mintPk);
    const creatorPk = new PublicKey(creator);

    if (options?.fromNarrativeWatchlist) {
      this.tieredMonitor.registerDirectWarm(
        mint,
        bondingCurvePDA,
        creatorPk,
        metadata,
        initialState,
        true,
      );
    } else {
      this.tieredMonitor.register(mint, bondingCurvePDA, creatorPk, metadata, initialState);
    }
    this.tradeHistory.set(mint, []);
    console.log(
      `📝 [CurveTracker] Registered ${mint.slice(0, 8)}…${options?.fromNarrativeWatchlist ? ' (narrative watchlist → WARM)' : ''}`,
    );
  }

  /**
   * Force promote a curve to HOT tier (e.g. when PumpScanner detects high liquidity).
   */
  forcePromoteHot(mint: string): void {
    this.tieredMonitor?.promoteCurve(mint, 0.51);
  }

  recordTrade(event: CurveTradeEvent): void {
    let history = this.tradeHistory.get(event.mint);
    if (!history) {
      history = [];
      this.tradeHistory.set(event.mint, history);
    }
    history.push(event);
    if (history.length > MAX_TRADE_HISTORY) {
      history.shift();
    }

    const curve = this.getCurveState(event.mint);
    if (curve) {
      if (event.synthetic) {
        curve.syntheticFlowEventCount = (curve.syntheticFlowEventCount ?? 0) + 1;
      } else if (event.isBuy) {
        curve.tradeCount += 1;
      }
    }
  }

  getTradeHistory(mint: string): CurveTradeEvent[] {
    return this.tradeHistory.get(mint) ?? [];
  }

  getCurveState(mint: string): TrackedCurve | null {
    if (!this.tieredMonitor) return null;
    return (
      this.tieredMonitor.hot.get(mint) ??
      this.tieredMonitor.warm.get(mint) ??
      this.tieredMonitor.cold.get(mint) ??
      null
    );
  }

  getHotCurves(): TrackedCurve[] {
    if (!this.tieredMonitor) return [];
    return Array.from(this.tieredMonitor.hot.values());
  }

  /** Toutes les courbes suivies (cold + warm + hot) — ex. matching NarrativeRadar. */
  getAllTrackedCurves(): TrackedCurve[] {
    if (!this.tieredMonitor) return [];
    const { cold, warm, hot } = this.tieredMonitor;
    return [
      ...cold.values(),
      ...warm.values(),
      ...hot.values(),
    ];
  }

  getStats(): { cold: number; warm: number; hot: number; total: number; evictions: number } {
    if (!this.tieredMonitor) {
      return { cold: 0, warm: 0, hot: 0, total: 0, evictions: 0 };
    }
    return this.tieredMonitor.getStats();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.tieredMonitor?.stop();
    this.started = false;
    console.log('🛑 [CurveTracker] Stopped');
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private buildConnections(): Connection[] {
    const conns: Connection[] = [];
    const helius = process.env.HELIUS_RPC_URL ?? process.env.RPC_URL;
    const qn = process.env.QUICKNODE_RPC_URL;

    if (helius) conns.push(new Connection(helius, 'confirmed'));
    if (qn) conns.push(new Connection(qn, 'confirmed'));

    if (conns.length === 0) {
      conns.push(new Connection('https://api.mainnet-beta.solana.com', 'confirmed'));
    }
    return conns;
  }
}
