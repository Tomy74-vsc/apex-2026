import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  PUMP_PROGRAM_ID,
  BONDING_CURVE_DISCRIMINATOR,
  BONDING_CURVE_ACCOUNT_SIZE,
} from '../constants/pumpfun.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Interfaces
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Etat brut du compte BondingCurve on-chain (82 bytes apres discriminateur).
 * Tous les montants restent en bigint — les conversions se font dans TrackedCurve.
 */
export interface BondingCurveState {
  virtualTokenReserves: bigint;   // u64 LE @0x00
  virtualSolReserves: bigint;     // u64 LE @0x08
  realTokenReserves: bigint;      // u64 LE @0x10
  realSolReserves: bigint;        // u64 LE @0x18
  tokenTotalSupply: bigint;       // u64 LE @0x20
  complete: boolean;              // u8    @0x28
  creator: PublicKey;             // 32B   @0x29
  isMayhemMode: boolean;          // u8    @0x49
}

/**
 * Etat enrichi pour le monitoring tiered (cold/warm/hot).
 * Les valeurs en SOL sont converties depuis les lamports du BondingCurveState.
 */
export interface TrackedCurve {
  mint: string;
  bondingCurvePDA: PublicKey;
  state: BondingCurveState;
  progress: number;               // 0.0 – 1.0
  realSolSOL: number;             // realSolReserves en SOL
  priceSOL: number;               // prix courant en SOL
  marketCapSOL: number;
  isKOTH: boolean;
  createdAt: number;              // Unix ms
  lastUpdated: number;            // Unix ms
  tier: 'cold' | 'warm' | 'hot';
  /** Achats wallet non-synthétiques (tx parsées) — aligné MIN_TRADE / vélocité wallet. */
  tradeCount: number;
  /** Événements Δ réserves (poll) — exclus des heuristiques bot/wallet. */
  syntheticFlowEventCount: number;
  metadata: { name?: string; symbol?: string; uri?: string };

  /** Phase B: set when promoted to HOT (predictor min time-in-HOT gate). */
  lastPromotedToHot?: number;
  /** Last progress before the most recent on-chain update (eviction / stall heuristics). */
  previousProgress?: number;
  /** Last time |progress| moved more than ~0.1% (TieredMonitor maintenance). */
  lastProgressChangeAt: number;
  /** Wall-clock when curve entered HOT tier. */
  hotSince?: number;
  /** Progress snapshot at HOT entry (stall detection). */
  progressAtHotEntry?: number;
  /** True si la courbe a été enregistrée en WARM via pre-alert watchlist (narratif avant mint). */
  narrativeMatch?: boolean;
}

/** Evenement de trade observe sur une bonding curve. */
export interface CurveTradeEvent {
  mint: string;
  isBuy: boolean;
  solAmount: number;              // en SOL (pas lamports)
  tokenAmount: bigint;
  trader: string;
  slot: number;
  timestamp: number;
  signature: string;
  /** Dérivé du poll (Δ réserves) — utile vélocité ; exclu des heuristiques bot/wallet. */
  synthetic?: boolean;
}

/** Evenement de graduation (complete passe a true). */
export interface GraduationEvent {
  mint: string;
  totalSolRaised: number;         // en SOL
  tradeDuration_s: number;        // secondes depuis creation
  finalTradeCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Decodeur
// ═══════════════════════════════════════════════════════════════════════════════

const DISC_LEN = 8;

/**
 * Decode un buffer de compte BondingCurve Pump.fun.
 * Attend >=90 bytes (8 discriminateur + 82 data).
 * Valide le discriminateur avant de parser.
 */
export function decodeBondingCurve(data: Buffer): BondingCurveState {
  if (data.length < BONDING_CURVE_ACCOUNT_SIZE) {
    throw new Error(
      `BondingCurve buffer trop petit: ${data.length} < ${BONDING_CURVE_ACCOUNT_SIZE}`,
    );
  }

  for (let i = 0; i < DISC_LEN; i++) {
    const got = data[i];
    const want = BONDING_CURVE_DISCRIMINATOR[i];
    if (got === undefined || want === undefined || got !== want) {
      throw new Error(
        `Discriminateur invalide a l'index ${i}: 0x${(got ?? 0).toString(16)} != 0x${(want ?? 0).toString(16)}`,
      );
    }
  }

  const d = DISC_LEN;
  return {
    virtualTokenReserves: data.readBigUInt64LE(d + 0x00),
    virtualSolReserves:   data.readBigUInt64LE(d + 0x08),
    realTokenReserves:    data.readBigUInt64LE(d + 0x10),
    realSolReserves:      data.readBigUInt64LE(d + 0x18),
    tokenTotalSupply:     data.readBigUInt64LE(d + 0x20),
    complete:             data[d + 0x28] === 1,
    creator:              new PublicKey(data.subarray(d + 0x29, d + 0x29 + 32)),
    isMayhemMode:         data[d + 0x49] === 1,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. PDA derivation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Derive le PDA du compte BondingCurve pour un mint donne.
 * Seeds: ["bonding-curve", mint.toBuffer()]
 */
export function deriveBondingCurvePDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID,
  );
}

/**
 * Derive l'ATA (Associated Token Account) du BondingCurve PDA pour un mint.
 * allowOwnerOffCurve=true car le owner est un PDA.
 */
export function deriveAssociatedBondingCurve(
  mint: PublicKey,
  curvePDA: PublicKey,
): PublicKey {
  return getAssociatedTokenAddressSync(mint, curvePDA, true);
}
