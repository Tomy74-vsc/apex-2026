/**
 * Bandes d'entrée courbe — source unique pour Guard + GraduationPredictor (APEX §5 sweet spot).
 */

export const DEFAULT_CURVE_ENTRY_MIN_PROGRESS = 0.45;
export const DEFAULT_CURVE_ENTRY_MAX_PROGRESS = 0.85;

function envFloat(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

export function readCurveEntryMinProgress(): number {
  return envFloat('CURVE_ENTRY_MIN_PROGRESS', DEFAULT_CURVE_ENTRY_MIN_PROGRESS);
}

export function readCurveEntryMaxProgress(): number {
  return envFloat('CURVE_ENTRY_MAX_PROGRESS', DEFAULT_CURVE_ENTRY_MAX_PROGRESS);
}
