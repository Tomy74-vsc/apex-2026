import {
  INITIAL_VIRTUAL_SOL_RESERVES,
  FEE_BASIS_POINTS,
} from '../../constants/pumpfun.js';
import { calcExpectedReturnOnGraduation } from '../../math/curve-math.js';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS_BASE = 10_000n;

function envFloatMargin(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * Round-trip fee multiplier: buy fee + sell fee.
 * Each side = FEE_BASIS_POINTS / 10000 = 1.25%
 * Round-trip = 1 / (1 - fee)^2 ≈ 1.025 for 1.25% per side.
 */
const ROUND_TRIP_FEE_MULTIPLIER =
  Number(BPS_BASE * BPS_BASE) /
  Number((BPS_BASE - FEE_BASIS_POINTS) * (BPS_BASE - FEE_BASIS_POINTS));

export interface BreakevenResult {
  minPGrad: number;
  minPGradWithMargin: number;
  expectedReturn: number;
  roundTripFeePct: number;
  entryRealSol: number;
}

/**
 * APEX_QUANT_STRATEGY §6 — higher margin when confidence in p̂ is low.
 * safety_margin(c) = 1 + (1 − c) × 0.8
 */
export function safetyMarginFromConfidence(confidence: number): number {
  const c = Math.max(0, Math.min(1, confidence));
  return 1 + (1 - c) * 0.8;
}

/**
 * Breakeven threshold with dynamic margin (no fixed 1.2×).
 */
export function calcBreakevenWithConfidence(
  realSolLamports: bigint,
  confidence: number,
  options?: { /** [0,1] momentum marché global (NarrativeRadar Grok ~15min) — assouplit légèrement le plancher SAFETY_MARGIN_BASE */
    marketMomentum?: number },
): BreakevenResult {
  const base = calcBreakeven(realSolLamports, 1);
  const dynamicMult = safetyMarginFromConfidence(confidence);
  /** Directive optional floor vs APEX dynamic margin — default 1 = no change. */
  const baseFloor = envFloatMargin('SAFETY_MARGIN_BASE', 1);
  /** Hot market: réduit le plancher effectif (max NARRATIVE_SAFETY_RELAX_MAX × momentum). */
  const relaxMax = envFloatMargin('NARRATIVE_SAFETY_RELAX_MAX', 0.08);
  const mom = Math.max(0, Math.min(1, options?.marketMomentum ?? 0));
  const floorMult = baseFloor * (1 - relaxMax * mom);
  const safetyFloor = envFloatMargin('SAFETY_MARGIN_FLOOR', 1.2);
  const mult = Math.max(dynamicMult, floorMult, safetyFloor);
  return {
    ...base,
    minPGradWithMargin: Math.min(1, base.minPGrad * mult),
  };
}

/**
 * Calcule le seuil minimum de P(graduation) pour que l'entree soit profitable.
 *
 * minPGrad(realSol) = roundTripFee / expectedReturn
 *
 * Sweet spot: entrer la ou pGrad_estime > minPGrad × 1.2 (marge 20%).
 */
export function calcBreakeven(realSolLamports: bigint, safetyMargin = 1.2): BreakevenResult {
  const expectedReturn = calcExpectedReturnOnGraduation(realSolLamports);
  const entryRealSol = Number(realSolLamports) / Number(LAMPORTS_PER_SOL);

  if (expectedReturn <= 0) {
    return {
      minPGrad: 1,
      minPGradWithMargin: 1,
      expectedReturn: 0,
      roundTripFeePct: ROUND_TRIP_FEE_MULTIPLIER - 1,
      entryRealSol,
    };
  }

  // minPGrad = fees / return. If return is 2x and fees are 2.5%, minPGrad ≈ 51.25%
  const minPGrad = Math.min(1, ROUND_TRIP_FEE_MULTIPLIER / expectedReturn);
  const minPGradWithMargin = Math.min(1, minPGrad * safetyMargin);

  return {
    minPGrad,
    minPGradWithMargin,
    expectedReturn,
    roundTripFeePct: (ROUND_TRIP_FEE_MULTIPLIER - 1) * 100,
    entryRealSol,
  };
}

/**
 * Quick check: is P(graduation) estimate above breakeven + safety margin?
 */
export function isEntryProfitable(
  pGrad: number,
  realSolLamports: bigint,
  safetyMargin = 1.2,
): boolean {
  const { minPGradWithMargin } = calcBreakeven(realSolLamports, safetyMargin);
  return pGrad > minPGradWithMargin;
}
