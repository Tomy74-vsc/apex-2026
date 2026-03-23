/**
 * Phase B — Pre-AIBrain gates (roadmapv4 1C subset).
 * Cheap filters before GraduationPredictor + Kelly (velocity window, trivial tx ratio).
 */

import type { CurveTradeEvent, TrackedCurve } from '../../types/bonding-curve.js';
import type { VelocitySignal } from '../graduation-predictor/VelocityAnalyzer.js';

export interface EntryGateResult {
  ok: boolean;
  failedGate?: string;
  detail?: string;
}

function envFloat(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * 1) First 60s of curve life: require SOL/min momentum (default 0.5).
 * 2) If enough buys: trivial tx ratio (amount < TRIVIAL_TX_SOL) must stay below MAX_TRIVIAL_TX_RATIO.
 */
export function evaluateEntryGates(
  curve: TrackedCurve,
  trades: CurveTradeEvent[],
  velocity: VelocitySignal,
): EntryGateResult {
  const ageSec = (Date.now() - curve.createdAt) / 1000;
  const minVel = envFloat('MIN_VELOCITY_SOL_MIN', 0.5);
  const firstWindowSec = envFloat('ENTRY_VELOCITY_WINDOW_SEC', 60);

  if (ageSec > 0 && ageSec <= firstWindowSec) {
    if (velocity.solPerMinute_1m < minVel) {
      return {
        ok: false,
        failedGate: 'VELOCITY_FIRST_WINDOW',
        detail: `sol/min ${velocity.solPerMinute_1m.toFixed(3)} < ${minVel} (first ${firstWindowSec}s)`,
      };
    }
  }

  const buys = trades.filter((t) => t.isBuy);
  const trivialLamport = envFloat('TRIVIAL_TX_SOL', 0.001);
  const maxTrivial = envFloat('MAX_TRIVIAL_TX_RATIO', 0.6);
  const minBuysForTrivial = envFloat('ENTRY_FILTER_MIN_BUYS_TRIVIAL', 5);

  if (buys.length >= minBuysForTrivial) {
    let trivial = 0;
    for (const b of buys) {
      if (b.solAmount < trivialLamport) trivial++;
    }
    const ratio = trivial / buys.length;
    if (ratio > maxTrivial) {
      return {
        ok: false,
        failedGate: 'TRIVIAL_TX_RATIO',
        detail: `trivial ${(ratio * 100).toFixed(1)}% > ${(maxTrivial * 100).toFixed(0)}% (< ${trivialLamport} SOL)`,
      };
    }
  }

  return { ok: true };
}
