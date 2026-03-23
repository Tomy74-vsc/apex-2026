import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { BatchPoller } from './BatchPoller.js';
import type { BondingCurveState, TrackedCurve, CurveTradeEvent } from '../../types/bonding-curve.js';
import { calcProgress, calcPricePerToken, calcMarketCapSOL } from '../../math/curve-math.js';
import {
  COLD_POLL_INTERVAL_MS,
  WARM_POLL_INTERVAL_MS,
  HOT_POLL_INTERVAL_MS,
  KOTH_SOL_THRESHOLD,
} from '../../constants/pumpfun.js';
import { getPositionManager } from '../position/PositionManager.js';

const MAX_COLD = 5_000;
const MAX_WARM = 200;
const MAX_HOT = 30;
const WARM_STALE_MS = 6 * 60 * 60_000; // 6h without change → demote
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Phase B eviction tuning (env override, minutes/ms). */
const MS = 60_000;
const HOT_STALL_MIN = parseInt(process.env.TIER_HOT_STALL_MIN ?? '30', 10) || 30;
const HOT_MAX_AGE_MIN = parseInt(process.env.TIER_HOT_MAX_AGE_MIN ?? '60', 10) || 60;
const WARM_MAX_AGE_MIN = parseInt(process.env.TIER_WARM_MAX_AGE_MIN ?? '120', 10) || 120;
const COLD_STALE_MIN = parseInt(process.env.TIER_COLD_STALE_MIN ?? '120', 10) || 120;
const PROGRESS_COLLAPSE_MIN = parseInt(process.env.TIER_PROGRESS_COLLAPSE_MIN ?? '10', 10) || 10;
const HOT_PROGRESS_EPS = 0.01;
const EVICTION_SWEEP_MS = parseInt(process.env.TIER_EVICTION_SWEEP_MS ?? '60000', 10) || 60_000;

/** Captured before tier maps are cleared (for `curve_outcomes` / ML). */
export interface CurveEvictionSnapshot {
  progress: number;
  realSol: number;
  createdAt: number;
  creator?: string;
}

export class TieredMonitor extends EventEmitter {
  readonly cold: Map<string, TrackedCurve> = new Map();
  readonly warm: Map<string, TrackedCurve> = new Map();
  readonly hot: Map<string, TrackedCurve> = new Map();

  readonly batchPoller: BatchPoller;

  private coldInterval: ReturnType<typeof setInterval> | null = null;
  private warmInterval: ReturnType<typeof setInterval> | null = null;
  private hotInterval: ReturnType<typeof setInterval> | null = null;
  private evictionSweep: ReturnType<typeof setInterval> | null = null;
  private evictionCount = 0;

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

    const now = Date.now();
    const curve: TrackedCurve = {
      mint,
      bondingCurvePDA,
      state,
      progress,
      realSolSOL,
      priceSOL: initialState ? calcPricePerToken(state.virtualSolReserves, state.virtualTokenReserves) : 0,
      marketCapSOL: initialState ? calcMarketCapSOL(state.virtualSolReserves, state.virtualTokenReserves) : 0,
      isKOTH: realSolSOL >= KOTH_SOL_THRESHOLD,
      createdAt: now,
      lastUpdated: now,
      tier: 'cold',
      tradeCount: 0,
      syntheticFlowEventCount: 0,
      metadata: metadata ?? {},
      lastProgressChangeAt: now,
    };

    this.cold.set(mint, curve);
    this.batchPoller.register(mint, bondingCurvePDA);
  }

  /**
   * Pre-alert narrative watchlist : évite COLD, démarre en WARM (polling warm/hot sans forcer HOT).
   */
  registerDirectWarm(
    mint: string,
    bondingCurvePDA: PublicKey,
    creator: PublicKey,
    metadata?: { name?: string; symbol?: string; uri?: string },
    initialState?: BondingCurveState,
    narrativeMatch = false,
  ): void {
    if (this.cold.has(mint) || this.warm.has(mint) || this.hot.has(mint)) return;

    this.enforceCapacity(this.warm, MAX_WARM);

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

    const now = Date.now();
    const curve: TrackedCurve = {
      mint,
      bondingCurvePDA,
      state,
      progress,
      realSolSOL,
      priceSOL: initialState ? calcPricePerToken(state.virtualSolReserves, state.virtualTokenReserves) : 0,
      marketCapSOL: initialState ? calcMarketCapSOL(state.virtualSolReserves, state.virtualTokenReserves) : 0,
      isKOTH: realSolSOL >= KOTH_SOL_THRESHOLD,
      createdAt: now,
      lastUpdated: now,
      tier: 'warm',
      tradeCount: 0,
      syntheticFlowEventCount: 0,
      metadata: metadata ?? {},
      lastProgressChangeAt: now,
      narrativeMatch: narrativeMatch ? true : undefined,
    };

    this.warm.set(mint, curve);
    this.batchPoller.register(mint, bondingCurvePDA);
    console.log(
      `📡 [TieredMonitor] ${mint.slice(0, 8)}… registered WARM (skip COLD${narrativeMatch ? ', narrativeMatch' : ''})`,
    );
    this.emit('enterWarmZone', mint, curve);
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
      const t = Date.now();
      curve.lastPromotedToHot = t;
      curve.hotSince = t;
      curve.progressAtHotEntry = newProgress;
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
    try {
      if (getPositionManager().hasOpenPosition(mint)) {
        return;
      }
    } catch {
      /* cold path */
    }

    const ageMs = now - curve.createdAt;
    const ageMin = ageMs / MS;

    if (curve.state.complete) {
      this.evict(mint, 'graduated');
      return;
    }

    // Global: dead curve with almost no progress
    if (curve.progress < 0.05 && ageMin > PROGRESS_COLLAPSE_MIN) {
      this.evict(mint, 'progress_collapsed');
      return;
    }

    if (curve.tier === 'hot') {
      if (ageMin > HOT_MAX_AGE_MIN) {
        this.evict(mint, 'hot_timeout_60min');
        return;
      }
      const hotSince = curve.hotSince ?? curve.lastPromotedToHot ?? curve.createdAt;
      const hotAgeMin = (now - hotSince) / MS;
      const progDelta = curve.progress - (curve.progressAtHotEntry ?? curve.progress);
      if (hotAgeMin > HOT_STALL_MIN && progDelta < HOT_PROGRESS_EPS) {
        this.evict(mint, 'hot_stalled_30min');
        return;
      }
    }

    if (curve.tier === 'warm') {
      if (ageMin > WARM_MAX_AGE_MIN) {
        this.evict(mint, 'warm_timeout_2h');
        return;
      }
      if (ageMin > 30 && curve.progress < 0.2) {
        this.evict(mint, 'warm_regressed');
        return;
      }
    }

    if (curve.tier === 'cold') {
      if (ageMin > COLD_STALE_MIN && curve.progress < 0.15) {
        this.evict(mint, 'cold_stale_2h');
        return;
      }
    }

    if (curve.tier === 'warm' && (now - curve.lastUpdated) > WARM_STALE_MS) {
      this.warm.delete(mint);
      curve.tier = 'cold';
      this.cold.set(mint, curve);
    }
  }

  private evict(mint: string, reason: string): void {
    const curveState =
      this.hot.get(mint) ?? this.warm.get(mint) ?? this.cold.get(mint);
    const snap: CurveEvictionSnapshot = {
      progress: curveState?.progress ?? 0,
      realSol: curveState?.realSolSOL ?? 0,
      createdAt: curveState?.createdAt ?? Date.now(),
      creator: curveState ? curveState.state.creator.toBase58() : undefined,
    };

    this.cold.delete(mint);
    this.warm.delete(mint);
    this.hot.delete(mint);
    this.batchPoller.unregister(mint);
    this.evictionCount++;
    this.emit('evicted', mint, reason, snap);
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
    const now = Date.now();
    const oldProgress = curve.progress;
    const prevSol = curve.state.realSolReserves;
    const prevToken = curve.state.realTokenReserves;
    const newSol = state.realSolReserves;
    const newToken = state.realTokenReserves;
    const deltaSol = newSol - prevSol;
    /** Ignore bruit arrondi / micro-mises à jour compte. */
    const minLamports = 1_000n;
    if (deltaSol > minLamports || deltaSol < -minLamports) {
      const solAmount = Math.abs(Number(deltaSol)) / LAMPORTS_PER_SOL;
      const isBuy = deltaSol > 0n;
      const tokenDelta = prevToken - newToken;
      const tokenAmount = tokenDelta >= 0n ? tokenDelta : -tokenDelta;
      const evt: CurveTradeEvent = {
        mint: curve.mint,
        isBuy,
        solAmount,
        tokenAmount,
        trader: '_reserve_flow',
        slot: Math.floor(now / 1000),
        timestamp: now,
        signature: `rsrv:${curve.mint.slice(0, 8)}:${now}`,
        synthetic: true,
      };
      this.emit('syntheticTrade', evt);
    }

    curve.previousProgress = oldProgress;
    curve.state = state;
    curve.progress = calcProgress(state.realTokenReserves);
    curve.realSolSOL = Number(state.realSolReserves) / LAMPORTS_PER_SOL;
    curve.priceSOL = calcPricePerToken(state.virtualSolReserves, state.virtualTokenReserves);
    curve.marketCapSOL = calcMarketCapSOL(state.virtualSolReserves, state.virtualTokenReserves);
    curve.isKOTH = curve.realSolSOL >= KOTH_SOL_THRESHOLD;
    curve.lastUpdated = now;
    if (Math.abs(curve.progress - oldProgress) > 0.001) {
      curve.lastProgressChangeAt = now;
    }
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

    this.evictionSweep = setInterval(() => {
      try {
        this.runEvictionSweep();
      } catch {
        /* silent */
      }
    }, EVICTION_SWEEP_MS);

    console.log(
      `🚀 [TieredMonitor] Started — polling + eviction sweep every ${EVICTION_SWEEP_MS / 1000}s`,
    );
  }

  stop(): void {
    if (this.coldInterval) { clearInterval(this.coldInterval); this.coldInterval = null; }
    if (this.warmInterval) { clearInterval(this.warmInterval); this.warmInterval = null; }
    if (this.hotInterval)  { clearInterval(this.hotInterval);  this.hotInterval = null; }
    if (this.evictionSweep) { clearInterval(this.evictionSweep); this.evictionSweep = null; }
    console.log('🛑 [TieredMonitor] Stopped');
  }

  getStats(): { cold: number; warm: number; hot: number; total: number; evictions: number } {
    return {
      cold: this.cold.size,
      warm: this.warm.size,
      hot: this.hot.size,
      total: this.cold.size + this.warm.size + this.hot.size,
      evictions: this.evictionCount,
    };
  }

  /** Periodic pass over all tiers (Phase B — catches stalled curves between polls). */
  private runEvictionSweep(): void {
    const tiers = [this.cold, this.warm, this.hot] as const;
    for (const tier of tiers) {
      for (const [mint, curve] of tier) {
        this.demoteOrEvict(mint, curve);
      }
    }
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
      const victim = this.findOldestEvictableMint(tier);
      if (victim === undefined) break;
      this.evict(victim, `capacity_${max}`);
    }
  }

  /** Never evict a mint with an open position (Phase B). */
  private findOldestEvictableMint(tier: Map<string, TrackedCurve>): string | undefined {
    let best: string | undefined;
    let bestT = Infinity;
    try {
      const pm = getPositionManager();
      for (const [mint, c] of tier) {
        if (pm.hasOpenPosition(mint)) continue;
        if (c.createdAt < bestT) {
          bestT = c.createdAt;
          best = mint;
        }
      }
    } catch {
      const first = tier.keys().next().value;
      return first;
    }
    return best;
  }
}
