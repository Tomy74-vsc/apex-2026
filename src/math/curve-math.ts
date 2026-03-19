import {
  INITIAL_VIRTUAL_TOKEN_RESERVES,
  INITIAL_VIRTUAL_SOL_RESERVES,
  INITIAL_REAL_TOKEN_RESERVES,
  TOKEN_TOTAL_SUPPLY,
  FEE_BASIS_POINTS,
} from '../constants/pumpfun.js';

// Pre-computed invariant k = vSol_0 × vToken_0
const K = INITIAL_VIRTUAL_SOL_RESERVES * INITIAL_VIRTUAL_TOKEN_RESERVES;

const BPS_BASE = 10_000n;
const BPS_NET = BPS_BASE - FEE_BASIS_POINTS; // 9875n
const LAMPORTS_PER_SOL = 1_000_000_000n;

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Progress
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Progression de la bonding curve : 0.0 (debut) → 1.0 (graduation).
 * progress = 1 - realTokenReserves / INITIAL_REAL_TOKEN_RESERVES
 */
export function calcProgress(realTokenReserves: bigint): number {
  if (realTokenReserves >= INITIAL_REAL_TOKEN_RESERVES) return 0;
  if (realTokenReserves <= 0n) return 1.0;
  return 1 - Number(realTokenReserves) / Number(INITIAL_REAL_TOKEN_RESERVES);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Prix par token
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Prix courant d'un token en lamports bruts (vSol / vToken).
 * Pour obtenir le prix en SOL : diviser par 1e9 puis multiplier par 1e6 (decimals).
 */
export function calcPricePerToken(vSol: bigint, vToken: bigint): number {
  if (vToken === 0n) return 0;
  return Number(vSol) / Number(vToken);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Market cap
// ═══════════════════════════════════════════════════════════════════════════════

/** Market cap en SOL = (vSol × totalSupply / vToken) converti en SOL. */
export function calcMarketCapSOL(vSol: bigint, vToken: bigint): number {
  if (vToken === 0n) return 0;
  const mcapLamports = (vSol * TOKEN_TOTAL_SUPPLY) / vToken;
  return Number(mcapLamports) / Number(LAMPORTS_PER_SOL);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Buy output
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calcule le nombre de tokens recus pour un achat de `solInLamports`.
 * Applique la fee (1.25%) en amont, puis constant-product.
 */
export function calcBuyOutput(
  vSol: bigint,
  vToken: bigint,
  solInLamports: bigint,
): bigint {
  if (solInLamports <= 0n || vSol <= 0n || vToken <= 0n) return 0n;
  const solAfterFee = (solInLamports * BPS_NET) / BPS_BASE;
  const k = vSol * vToken;
  const newVSol = vSol + solAfterFee;
  if (newVSol <= 0n) return 0n;
  const newVToken = k / newVSol;
  const tokensOut = vToken - newVToken;
  return tokensOut > 0n ? tokensOut : 0n;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Sell output
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calcule les lamports SOL recus pour une vente de `tokenIn` tokens.
 * Fee (1.25%) appliquee sur le SOL brut en sortie.
 */
export function calcSellOutput(
  vSol: bigint,
  vToken: bigint,
  tokenIn: bigint,
): bigint {
  if (tokenIn <= 0n || vSol <= 0n || vToken <= 0n) return 0n;
  const k = vSol * vToken;
  const newVToken = vToken + tokenIn;
  const newVSol = k / newVToken;
  const grossSol = vSol - newVSol;
  if (grossSol <= 0n) return 0n;
  const solOut = (grossSol * BPS_NET) / BPS_BASE;
  return solOut > 0n ? solOut : 0n;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. SOL requis pour un % de progress
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Inverse de calcProgress : combien de lamports SOL reels pour atteindre `targetProgress`.
 * Inclut l'ajustement pour les fees.
 */
export function calcRequiredSolForProgress(targetProgress: number): bigint {
  if (targetProgress <= 0) return 0n;
  if (targetProgress >= 1) return calcRequiredSolForProgress(0.9999);

  // Target real token reserves quand on atteint targetProgress
  const targetRealTokenBig = BigInt(
    Math.round(Number(INITIAL_REAL_TOKEN_RESERVES) * (1 - targetProgress)),
  );

  // vToken correspondant : rToken + (vToken_0 - rToken_0) = rToken + delta_virtual
  const virtualDelta = INITIAL_VIRTUAL_TOKEN_RESERVES - INITIAL_REAL_TOKEN_RESERVES;
  const targetVToken = targetRealTokenBig + virtualDelta;
  if (targetVToken <= 0n) return 0n;

  const targetVSol = K / targetVToken;
  const realSolNeeded = targetVSol - INITIAL_VIRTUAL_SOL_RESERVES;
  if (realSolNeeded <= 0n) return 0n;

  // Ajuster pour les fees : on paie gross = net / (1 - fee_rate)
  const grossSol = (realSolNeeded * BPS_BASE) / BPS_NET;
  return grossSol;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Price impact
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Impact de prix pour un achat de `solIn` lamports.
 * Retourne un ratio positif (0.05 = 5%).
 */
export function calcPriceImpact(
  vSol: bigint,
  vToken: bigint,
  solIn: bigint,
): number {
  if (solIn <= 0n || vSol <= 0n || vToken <= 0n) return 0;
  const priceBefore = calcPricePerToken(vSol, vToken);
  if (priceBefore === 0) return 0;
  const tokensOut = calcBuyOutput(vSol, vToken, solIn);
  const solAfterFee = (solIn * BPS_NET) / BPS_BASE;
  const priceAfter = calcPricePerToken(vSol + solAfterFee, vToken - tokensOut);
  return (priceAfter - priceBefore) / priceBefore;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Return attendu a la graduation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Multiple attendu si le token gradue depuis la position actuelle.
 * Ex: 1.5 = +50% de gain.
 *
 * @param currentRealSol - reserves SOL reelles actuelles (lamports)
 */
export function calcExpectedReturnOnGraduation(currentRealSol: bigint): number {
  // Etat actuel : vSol = initial_virtual + realSol
  const currentVSol = INITIAL_VIRTUAL_SOL_RESERVES + currentRealSol;
  const currentVToken = K / currentVSol;
  if (currentVToken <= 0n) return 0;

  // Etat a graduation : ~85 SOL reel → vSol = 30 + 85 = 115 SOL
  const gradRealSol = 85_000_000_000n;
  const gradVSol = INITIAL_VIRTUAL_SOL_RESERVES + gradRealSol;
  const gradVToken = K / gradVSol;
  if (gradVToken <= 0n) return 0;

  const priceCurrent = calcPricePerToken(currentVSol, currentVToken);
  const priceGrad = calcPricePerToken(gradVSol, gradVToken);
  if (priceCurrent === 0) return 0;

  return priceGrad / priceCurrent;
}
