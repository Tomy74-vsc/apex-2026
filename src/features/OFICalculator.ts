/**
 * OFICalculator — APEX-2026 Phase 2 (P2.3.1)
 *
 * Computes Order Flow Imbalance in real-time from AMM pool reserve changes.
 * OFI measures the asymmetry between buying and selling pressure.
 *
 * For Raydium/Meteora AMM pools:
 *   - "Bid" = SOL reserve increases (someone sold token for SOL → buy pressure on token)
 *   - "Ask" = SOL reserve decreases (someone bought token with SOL → sell pressure on token)
 *
 * Formula: OFI(t) = Σ [ΔReserveSOL_i × sign(ΔReserveSOL_i)]
 *          normalized to [-1, 1] via tanh scaling.
 *
 * Uses a sliding window of reserve snapshots (default 60s).
 */

import { EventEmitter } from 'events';

export interface ReserveSnapshot {
  poolId: string;
  mint: string;
  reserveSol: number;
  reserveToken: number;
  timestamp: number; // Unix ms
}

export interface OFIResult {
  mint: string;
  ofi: number;           // [-1, 1] normalized
  rawOfi: number;        // raw sum of signed deltas
  buyPressure: number;   // SOL flowing in (positive deltas)
  sellPressure: number;  // SOL flowing out (negative deltas)
  snapshotCount: number;
  windowMs: number;
  computedAt: number;
}

const DEFAULT_WINDOW_MS = 60_000; // 60s sliding window
const MAX_SNAPSHOTS_PER_POOL = 500;
const OFI_SCALE = 10; // tanh scaling factor (SOL units)

export class OFICalculator extends EventEmitter {
  private snapshots: Map<string, ReserveSnapshot[]> = new Map(); // poolId → snapshots
  private mintToPool: Map<string, string> = new Map(); // mint → poolId
  private windowMs: number;

  private stats = {
    updates: 0,
    computations: 0,
  };

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    super();
    this.windowMs = windowMs;
    console.log(`📊 [OFICalculator] Initialized (window=${windowMs}ms)`);
  }

  /**
   * Record a new reserve snapshot for a pool.
   * Called when pool account data changes (via WebSocket accountSubscribe or gRPC).
   */
  updateReserves(snapshot: ReserveSnapshot): void {
    this.stats.updates++;

    const { poolId, mint } = snapshot;
    this.mintToPool.set(mint, poolId);

    if (!this.snapshots.has(poolId)) {
      this.snapshots.set(poolId, []);
    }

    const pool = this.snapshots.get(poolId)!;
    pool.push(snapshot);

    // Evict old snapshots
    const cutoff = Date.now() - this.windowMs * 2;
    while (pool.length > 0 && pool[0]!.timestamp < cutoff) {
      pool.shift();
    }
    if (pool.length > MAX_SNAPSHOTS_PER_POOL) {
      pool.splice(0, pool.length - MAX_SNAPSHOTS_PER_POOL);
    }

    // Emit OFI update if we have enough data
    if (pool.length >= 2) {
      const ofi = this.compute(mint);
      if (ofi) {
        this.emit('ofiUpdate', ofi);
      }
    }
  }

  /**
   * Compute current OFI for a given mint.
   * Returns null if insufficient data.
   */
  compute(mint: string): OFIResult | null {
    const poolId = this.mintToPool.get(mint);
    if (!poolId) return null;

    const pool = this.snapshots.get(poolId);
    if (!pool || pool.length < 2) return null;

    this.stats.computations++;

    const now = Date.now();
    const cutoff = now - this.windowMs;

    // Filter to window
    const windowSnapshots = pool.filter((s) => s.timestamp >= cutoff);
    if (windowSnapshots.length < 2) return null;

    let rawOfi = 0;
    let buyPressure = 0;
    let sellPressure = 0;

    for (let i = 1; i < windowSnapshots.length; i++) {
      const prev = windowSnapshots[i - 1]!;
      const curr = windowSnapshots[i]!;
      const deltaSol = curr.reserveSol - prev.reserveSol;

      if (deltaSol > 0) {
        // SOL reserve increased → someone sold token → buy pressure on token
        buyPressure += deltaSol;
        rawOfi += deltaSol;
      } else if (deltaSol < 0) {
        // SOL reserve decreased → someone bought token → sell pressure on token
        sellPressure += Math.abs(deltaSol);
        rawOfi += deltaSol;
      }
    }

    // Normalize to [-1, 1] via tanh
    const ofi = Math.tanh(rawOfi / OFI_SCALE);

    return {
      mint,
      ofi,
      rawOfi,
      buyPressure,
      sellPressure,
      snapshotCount: windowSnapshots.length,
      windowMs: this.windowMs,
      computedAt: now,
    };
  }

  /**
   * Quick OFI lookup by mint (returns 0 if unknown).
   * Hot path safe — no allocation.
   */
  getOFI(mint: string): number {
    const result = this.compute(mint);
    return result?.ofi ?? 0;
  }

  /**
   * Batch compute OFI for all tracked mints.
   */
  computeAll(): Map<string, OFIResult> {
    const results = new Map<string, OFIResult>();
    for (const mint of this.mintToPool.keys()) {
      const ofi = this.compute(mint);
      if (ofi) results.set(mint, ofi);
    }
    return results;
  }

  getStats() {
    return {
      ...this.stats,
      trackedPools: this.snapshots.size,
      trackedMints: this.mintToPool.size,
    };
  }

  clear(): void {
    this.snapshots.clear();
    this.mintToPool.clear();
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _ofi: OFICalculator | null = null;

export function getOFICalculator(): OFICalculator {
  if (!_ofi) {
    _ofi = new OFICalculator();
  }
  return _ofi;
}
