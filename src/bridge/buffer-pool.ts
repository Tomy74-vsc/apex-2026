/**
 * BufferPool — APEX-2026 Anti-GC Buffer Management
 *
 * Pre-allocates Float64Array buffers at startup and recycles them
 * via a rotary index. Eliminates all allocations on the hot path.
 *
 * JSC (Bun's engine) GC pauses can reach 5-15ms on large heaps.
 * Every `new Float64Array()` in the hot path is a potential GC trigger.
 * This pool guarantees O(1) acquire with ZERO allocation.
 *
 * Usage:
 *   const pool = new BufferPool([
 *     { size: 12, count: 64 },   // feature vectors
 *     { size: 4, count: 64 },    // HMM state probabilities
 *     { size: 1536, count: 8 },  // TFT sequences (128 × 12)
 *   ]);
 *   const buf = pool.acquire(12);
 *   // ... use buf ...
 *   pool.release(buf);
 */

export interface PoolConfig {
  size: number;
  count: number;
}

export class BufferPool {
  private pools: Map<number, Float64Array[]> = new Map();
  private indices: Map<number, number> = new Map();
  private stats = {
    acquires: 0,
    releases: 0,
    misses: 0,
    totalAllocated: 0,
  };

  constructor(configs: PoolConfig[]) {
    for (const { size, count } of configs) {
      const pool: Float64Array[] = new Array(count);
      for (let i = 0; i < count; i++) {
        pool[i] = new Float64Array(size);
      }
      this.pools.set(size, pool);
      this.indices.set(size, 0);
      this.stats.totalAllocated += count;
    }
    console.log(
      `🛡️ [BufferPool] Pre-allocated ${this.stats.totalAllocated} buffers ` +
        `(${configs.map((c) => `${c.count}×${c.size}`).join(', ')})`,
    );
  }

  /**
   * Acquire a pre-allocated buffer of the given size.
   * O(1) — rotary index, never allocates.
   * If no pool exists for this size, falls back to a new allocation (logged as miss).
   */
  acquire(size: number): Float64Array {
    this.stats.acquires++;

    const pool = this.pools.get(size);
    if (!pool) {
      this.stats.misses++;
      return new Float64Array(size);
    }

    const idx = this.indices.get(size)!;
    const buf = pool[idx]!;
    this.indices.set(size, (idx + 1) % pool.length);

    buf.fill(0);
    return buf;
  }

  /**
   * Release a buffer back to the pool (no-op for rotary pool,
   * kept for API compatibility if switching to free-list later).
   */
  release(_buffer: Float64Array): void {
    this.stats.releases++;
  }

  /**
   * Zero-copy fill: writes values into a pre-allocated buffer.
   * Avoids creating intermediate arrays.
   */
  fill(size: number, values: ArrayLike<number>): Float64Array {
    const buf = this.acquire(size);
    const len = Math.min(buf.length, values.length);
    for (let i = 0; i < len; i++) {
      buf[i] = values[i]!;
    }
    return buf;
  }

  getStats() {
    return { ...this.stats };
  }
}

// ─── Default pool for APEX-2026 hot path ───────────────────────────────────

export const FEATURE_VECTOR_SIZE = 12;
export const HMM_STATE_SIZE = 4;
export const TFT_SEQ_SIZE = 128 * 12; // 128 timestamps × 12 features
export const HAWKES_EVENT_SIZE = 1024;

let _pool: BufferPool | null = null;

export function getBufferPool(): BufferPool {
  if (!_pool) {
    _pool = new BufferPool([
      { size: FEATURE_VECTOR_SIZE, count: 64 },
      { size: HMM_STATE_SIZE, count: 64 },
      { size: TFT_SEQ_SIZE, count: 8 },
      { size: HAWKES_EVENT_SIZE, count: 4 },
      { size: 2, count: 32 }, // Hawkes intensity output [λ_buy, λ_sell]
    ]);
  }
  return _pool;
}
