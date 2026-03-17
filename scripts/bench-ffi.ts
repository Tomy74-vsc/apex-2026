#!/usr/bin/env bun
/**
 * bench-ffi.ts — Benchmark: TS ↔ Rust FFI round-trip latency
 *
 * Measures:
 *   1. ping() round-trip (target: < 10μs)
 *   2. bench(N) computation (target: < 1μs for 12 multiplications)
 *   3. benchBuffer() TypedArray round-trip (target: < 10μs for 12 f64)
 *   4. BufferPool acquire/release overhead
 *
 * Usage: bun run scripts/bench-ffi.ts
 */

import { getBridge } from '../src/bridge/RustBridge.js';
import { getBufferPool, FEATURE_VECTOR_SIZE } from '../src/bridge/buffer-pool.js';

const ITERATIONS = 10_000;
const WARMUP = 1_000;

function formatUs(us: number): string {
  if (us < 1) return `${(us * 1000).toFixed(0)}ns`;
  if (us < 1000) return `${us.toFixed(2)}μs`;
  return `${(us / 1000).toFixed(2)}ms`;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         APEX-2026 — FFI Benchmark Suite                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const bridge = getBridge();
  console.log(`Bridge: ${bridge.name}`);
  console.log(`Native: ${bridge.isNative}`);
  console.log(`Version: ${bridge.version()}`);
  console.log(`Iterations: ${ITERATIONS} (warmup: ${WARMUP})\n`);

  // ─── 1. Ping Round-Trip ────────────────────────────────────────────────

  console.log('─── Test 1: ping() round-trip ───');
  for (let i = 0; i < WARMUP; i++) bridge.ping();

  const pingTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    bridge.ping();
    pingTimes.push((performance.now() - start) * 1000); // μs
  }
  pingTimes.sort((a, b) => a - b);
  console.log(`  median: ${formatUs(percentile(pingTimes, 50))}`);
  console.log(`  p95:    ${formatUs(percentile(pingTimes, 95))}`);
  console.log(`  p99:    ${formatUs(percentile(pingTimes, 99))}`);
  console.log(`  max:    ${formatUs(pingTimes[pingTimes.length - 1]!)}\n`);

  // ─── 2. Bench Computation ──────────────────────────────────────────────

  console.log('─── Test 2: bench(12) — 12 f64 multiplications ───');
  for (let i = 0; i < WARMUP; i++) bridge.bench(12);

  const benchTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    bridge.bench(12);
    benchTimes.push((performance.now() - start) * 1000);
  }
  benchTimes.sort((a, b) => a - b);
  console.log(`  median: ${formatUs(percentile(benchTimes, 50))}`);
  console.log(`  p95:    ${formatUs(percentile(benchTimes, 95))}`);
  console.log(`  p99:    ${formatUs(percentile(benchTimes, 99))}\n`);

  // ─── 3. Buffer Round-Trip ──────────────────────────────────────────────

  console.log('─── Test 3: benchBuffer(12) — Float64Array round-trip ───');
  const input = new Float64Array(FEATURE_VECTOR_SIZE);
  const output = new Float64Array(FEATURE_VECTOR_SIZE);
  for (let i = 0; i < FEATURE_VECTOR_SIZE; i++) input[i] = Math.random();

  for (let i = 0; i < WARMUP; i++) bridge.benchBuffer(input, output);

  const bufferTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    bridge.benchBuffer(input, output);
    bufferTimes.push((performance.now() - start) * 1000);
  }
  bufferTimes.sort((a, b) => a - b);
  console.log(`  median: ${formatUs(percentile(bufferTimes, 50))}`);
  console.log(`  p95:    ${formatUs(percentile(bufferTimes, 95))}`);
  console.log(`  p99:    ${formatUs(percentile(bufferTimes, 99))}\n`);

  // ─── 4. BufferPool Overhead ────────────────────────────────────────────

  console.log('─── Test 4: BufferPool acquire/release overhead ───');
  const pool = getBufferPool();

  for (let i = 0; i < WARMUP; i++) {
    const b = pool.acquire(FEATURE_VECTOR_SIZE);
    pool.release(b);
  }

  const poolTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    const b = pool.acquire(FEATURE_VECTOR_SIZE);
    pool.release(b);
    poolTimes.push((performance.now() - start) * 1000);
  }
  poolTimes.sort((a, b) => a - b);
  console.log(`  median: ${formatUs(percentile(poolTimes, 50))}`);
  console.log(`  p95:    ${formatUs(percentile(poolTimes, 95))}`);
  console.log(`  p99:    ${formatUs(percentile(poolTimes, 99))}\n`);

  // ─── 5. HMM Fallback Bench ────────────────────────────────────────────

  console.log('─── Test 5: inferHMM() — Hamilton filter ───');
  for (let i = 0; i < WARMUP; i++) bridge.inferHMM(0.001, 0.02, 0.5);

  const hmmTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const logReturn = (Math.random() - 0.5) * 0.01;
    const start = performance.now();
    bridge.inferHMM(logReturn, 0.02, 0.5);
    hmmTimes.push((performance.now() - start) * 1000);
  }
  hmmTimes.sort((a, b) => a - b);
  console.log(`  median: ${formatUs(percentile(hmmTimes, 50))}`);
  console.log(`  p95:    ${formatUs(percentile(hmmTimes, 95))}`);
  console.log(`  p99:    ${formatUs(percentile(hmmTimes, 99))}\n`);

  // ─── Summary ───────────────────────────────────────────────────────────

  console.log('═'.repeat(60));
  console.log('📊 SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Bridge:       ${bridge.name}`);
  console.log(`  ping p50:     ${formatUs(percentile(pingTimes, 50))}`);
  console.log(`  bench p50:    ${formatUs(percentile(benchTimes, 50))}`);
  console.log(`  buffer p50:   ${formatUs(percentile(bufferTimes, 50))}`);
  console.log(`  pool p50:     ${formatUs(percentile(poolTimes, 50))}`);
  console.log(`  hmm p50:      ${formatUs(percentile(hmmTimes, 50))}`);
  console.log(`  Pool stats:   ${JSON.stringify(pool.getStats())}`);
  console.log('═'.repeat(60));

  bridge.dispose();
}

main().catch(console.error);
