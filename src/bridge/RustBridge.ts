/**
 * RustBridge — Bun FFI Bridge to apex_core Rust library.
 *
 * Loads the compiled .dll/.so and exposes typed functions.
 * Falls back to FallbackBridge if the native library is unavailable.
 *
 * Hot path calls are synchronous (< 100μs target).
 * The bridge never throws — errors return default values + log.
 */

import { dlopen, FFIType, suffix, type Library } from 'bun:ffi';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { IApexBridge } from './types.js';
import { HMM_REGIMES, HMM_STATES } from './types.js';
import { FallbackBridge } from './fallback.js';
import { getBufferPool } from './buffer-pool.js';

// ─── Library path resolution ───────────────────────────────────────────────

function findLibrary(): string | null {
  const libName = `apex_core.${suffix}`;
  const candidates = [
    resolve(import.meta.dir, '../../rust_core/target/release', libName),
    resolve(import.meta.dir, '../../rust_core/target/debug', libName),
    resolve(import.meta.dir, '../../', libName),
    join(process.cwd(), 'rust_core/target/release', libName),
    join(process.cwd(), 'rust_core/target/debug', libName),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

// ─── FFI Symbol Definitions ────────────────────────────────────────────────

const FFI_SYMBOLS = {
  apex_ping: {
    returns: FFIType.f64,
    args: [],
  },
  apex_version: {
    returns: FFIType.u32,
    args: [],
  },
  apex_bench: {
    returns: FFIType.f64,
    args: [FFIType.u32],
  },
  apex_bench_buffer: {
    returns: FFIType.f64,
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
  },
} as const;

type ApexLib = Library<typeof FFI_SYMBOLS>;

// ─── Native Bridge ─────────────────────────────────────────────────────────

class NativeRustBridge implements IApexBridge {
  readonly isNative = true;
  readonly name: string;
  private lib: ApexLib;

  constructor(path: string) {
    this.lib = dlopen(path, FFI_SYMBOLS);
    this.name = `NativeRustBridge (${path})`;
    const ver = this.lib.symbols.apex_version();
    console.log(
      `✅ [RustBridge] Loaded native library v${Math.floor(ver / 10000)}.${Math.floor((ver % 10000) / 100)}.${ver % 100}`,
    );
  }

  ping(): number {
    return this.lib.symbols.apex_ping();
  }

  version(): number {
    return this.lib.symbols.apex_version();
  }

  bench(iterations: number): number {
    return this.lib.symbols.apex_bench(iterations);
  }

  benchBuffer(input: Float64Array, output: Float64Array): number {
    return this.lib.symbols.apex_bench_buffer(
      input as unknown as Uint8Array,
      output as unknown as Uint8Array,
      input.length,
    );
  }

  inferHMM(_logReturn: number, _realizedVol: number, _ofi: number): Float64Array {
    // Phase 3 — will call apex_hmm_filter via FFI
    const pool = getBufferPool();
    const result = pool.acquire(HMM_STATES);
    result.fill(1.0 / HMM_STATES);
    return result;
  }

  evalHawkesIntensity(_events: Float64Array, _now: number): [number, number] {
    // Phase 3 — will call apex_hawkes_intensity via FFI
    return [0.0, 0.0];
  }

  inferTFT(_featureSequence: Float64Array, _seqLen: number): Float64Array {
    // Phase 3 — will call apex_infer via FFI with TFT model
    const pool = getBufferPool();
    return pool.acquire(2);
  }

  dispose(): void {
    try {
      this.lib.close();
    } catch {
      // silencieux
    }
    console.log('✅ [RustBridge] Native library unloaded');
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Creates the best available bridge.
 * Tries native Rust FFI first, falls back to pure-TS if unavailable.
 */
export function createBridge(): IApexBridge {
  try {
    const libPath = findLibrary();
    if (libPath) {
      return new NativeRustBridge(libPath);
    }
    console.log('⚠️  [RustBridge] Native library not found, using fallback');
  } catch (err) {
    console.warn(`⚠️  [RustBridge] Failed to load native library: ${err}`);
  }
  return new FallbackBridge();
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _bridge: IApexBridge | null = null;

export function getBridge(): IApexBridge {
  if (!_bridge) {
    _bridge = createBridge();
  }
  return _bridge;
}

export { type IApexBridge } from './types.js';
