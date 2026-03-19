import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { BatchPoller } from './BatchPoller.js';
import type { BondingCurveState, TrackedCurve } from '../../types/bonding-curve.js';
import { calcProgress, calcPricePerToken, calcMarketCapSOL } from '../../math/curve-math.js';
import {
  COLD_POLL_INTERVAL_MS,
  WARM_POLL_INTERVAL_MS,
  HOT_POLL_INTERVAL_MS,
  KOTH_SOL_THRESHOLD,
  STALE_CURVE_TTL_MS,
} from '../../constants/pumpfun.js';

const MAX_COLD = 5_000;
const MAX_WARM = 200;
const MAX_HOT = 30;
const WARM_STALE_MS = 6 * 60 * 60_000; // 6h without change → demote
const LAMPORTS_PER_SOL = 1_000_000_000;

export class TieredMonitor extends EventEmitter {
  readonly cold: Map<string, TrackedCurve> = new Map();
  readonly warm: Map<string, TrackedCurve> = new Map();
  readonly hot: Map<string, TrackedCurve> = new Map();

  readonly batchPoller: BatchPoller;

  private coldInterval: ReturnType<typeof setInterval> | null = null;
  private warmInterval: ReturnType<typeof setInterval> | null = null;
  private hotInterval: ReturnType<typeof setInterval> | null = null;

  constructor(connections: Connection[]) {
    super();
    this.batchPoller = new BatchPoller(connections);
    this.batchPoller.on('stateUpdate', (mint: string, state: BondingCurveState) => {
      try { this.onStateUpdate(mint, state); } catch { /* silent */ }
    });
    this.batchPoller.on('graduated', (mint: string, state: BondingCurveState) => {
      try { this.handleGraduation(mint, state); } catch { /* silent */ }
    });
    this.batchPoller.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  // ─── Registration ──────────────────────────────────────────────────────────

  register(
    mint: string,
    bondingCurvePDA: PublicKey,
    creator: PublicKey,
    metadata?: { name?: string; symbol?: string; uri?: string },
    initialState?: BondingCurveState,
  ): void {
    if (this.cold.has(mint) || this.warm.has(mint) || this.hot.has(mint)) return;

    this.enforceCapacity(this.cold, MAX_COLD);

    const defaultState: BondingCurveState = {
      virtualTokenReserves: 0n,
      virtualSolReserves: 0n,
      realTokenReserves: 0n,
      realSolReserves: 0n,
      tokenTotalSupply: 0n,
      complete: false,
      creator,
      isMayhemMode: false,
    };

    const state = initialState ?? defaultState;
    const progress = initialState ? calcProgress(state.realTokenReserves) : 0;
    const realSolSOL = initialState ? Number(state.realSolReserves) / LAMPORTS_PER_SOL : 0;

    const curve: TrackedCurve = {
      mint,
      bondingCurvePDA,
      state,
      progress,
      realSolSOL,
      priceSOL: initialState ? calcPricePerToken(state.virtualSolReserves, state.virtualTokenReserves) : 0,
      marketCapSOL: initialState ? calcMarketCapSOL(state.virtualSolReserves, state.virtualTokenReserves) : 0,
      isKOTH: realSolSOL >= KOTH_SOL_THRESHOLD,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      tier: 'cold',
      tradeCount: 0,
      metadata: metadata ?? {},
    };

    this.cold.set(mint, curve);
    this.batchPoller.register(mint, bondingCurvePDA);
  }

  // ─── Tier promotion / demotion ─────────────────────────────────────────────

  promoteCurve(mint: string, newProgress: number): void {
    if (newProgress >= 0.50 && !this.hot.has(mint)) {
      const curve = this.warm.get(mint) ?? this.cold.get(mint);
      if (!curve) return;
      this.warm.delete(mint);
      this.cold.delete(mint);
      this.enforceCapacity(this.hot, MAX_HOT);
      curve.tier = 'hot';
      this.hot.set(mint, curve);
      console.log(`🔥 [TieredMonitor] ${mint.slice(0, 8)} entered HOT zone (${(newProgress * 100).toFixed(1)}%)`);
      this.emit('enterHotZone', mint, curve);
    } else if (newProgress >= 0.25 && !this.warm.has(mint) && !this.hot.has(mint)) {
      const curve = this.cold.get(mint);
      if (!curve) return;
      this.cold.delete(mint);
      this.enforceCapacity(this.warm, MAX_WARM);
      curve.tier = 'warm';
      this.warm.set(mint, curve);
      console.log(`⚠️ [TieredMonitor] ${mint.slice(0, 8)} promoted to WARM (${(newProgress * 100).toFixed(1)}%)`);
      this.emit('enterWarmZone', mint, curve);
    }
  }

  private demoteOrEvict(mint: string, curve: TrackedCurve): void {
    const now = Date.now();
    const age = now - curve.createdAt;

    if (curve.state.complete) {
      this.evict(mint, 'graduated');
      return;
    }

    if (curve.tier === 'cold' && age > STALE_CURVE_TTL_MS && curve.progress < 0.10) {
      this.evict(mint, 'stale_cold_24h');
      return;
    }

    if (curve.tier === 'warm' && (now - curve.lastUpdated) > WARM_STALE_MS) {
      this.warm.delete(mint);
      curve.tier = 'cold';
      this.cold.set(mint, curve);
    }
  }

  private evict(mint: string, reason: string): void {
    this.cold.delete(mint);
    this.warm.delete(mint);
    this.hot.delete(mint);
    this.batchPoller.unregister(mint);
    this.emit('evicted', mint, reason);
  }

  private handleGraduation(mint: string, state: BondingCurveState): void {
    const curve = this.hot.get(mint) ?? this.warm.get(mint) ?? this.cold.get(mint);
    if (curve) {
      this.updateCurveFromState(curve, state);
      this.emit('graduated', mint, curve);
    }
    this.evict(mint, 'graduated');
  }

  // ─── State update handler ──────────────────────────────────────────────────

  private onStateUpdate(mint: string, state: BondingCurveState): void {
    const curve = this.cold.get(mint) ?? this.warm.get(mint) ?? this.hot.get(mint);
    if (!curve) return;

    this.updateCurveFromState(curve, state);
    this.promoteCurve(mint, curve.progress);
    this.demoteOrEvict(mint, curve);
    this.emit('curveUpdate', mint, curve);
  }

  private updateCurveFromState(curve: TrackedCurve, state: BondingCurveState): void {
    curve.state = state;
    curve.progress = calcProgress(state.realTokenReserves);
    curve.realSolSOL = Number(state.realSolReserves) / LAMPORTS_PER_SOL;
    curve.priceSOL = calcPricePerToken(state.virtualSolReserves, state.virtualTokenReserves);
    curve.marketCapSOL = calcMarketCapSOL(state.virtualSolReserves, state.virtualTokenReserves);
    curve.isKOTH = curve.realSolSOL >= KOTH_SOL_THRESHOLD;
    curve.lastUpdated = Date.now();
  }

  // ─── Polling lifecycle ─────────────────────────────────────────────────────

  start(): void {
    if (this.coldInterval) return;

    this.coldInterval = setInterval(() => {
      void this.pollTier(this.cold);
    }, COLD_POLL_INTERVAL_MS);

    this.warmInterval = setInterval(() => {
      void this.pollTier(this.warm);
    }, WARM_POLL_INTERVAL_MS);

    this.hotInterval = setInterval(() => {
      void this.pollTier(this.hot);
    }, HOT_POLL_INTERVAL_MS);

    console.log('🚀 [TieredMonitor] Started — Cold/Warm/Hot polling active');
  }

  stop(): void {
    if (this.coldInterval) { clearInterval(this.coldInterval); this.coldInterval = null; }
    if (this.warmInterval) { clearInterval(this.warmInterval); this.warmInterval = null; }
    if (this.hotInterval)  { clearInterval(this.hotInterval);  this.hotInterval = null; }
    console.log('🛑 [TieredMonitor] Stopped');
  }

  getStats(): { cold: number; warm: number; hot: number; total: number } {
    return {
      cold: this.cold.size,
      warm: this.warm.size,
      hot: this.hot.size,
      total: this.cold.size + this.warm.size + this.hot.size,
    };
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private async pollTier(tier: Map<string, TrackedCurve>): Promise<void> {
    if (tier.size === 0) return;
    try {
      const mints = Array.from(tier.keys());
      await this.batchPoller.pollBatch(mints);
    } catch {
      /* silent — BatchPoller emits its own errors */
    }
  }

  private enforceCapacity(tier: Map<string, TrackedCurve>, max: number): void {
    while (tier.size >= max) {
      const oldest = tier.keys().next().value;
      if (oldest === undefined) break;
      this.evict(oldest, `capacity_${max}`);
    }
  }
}
