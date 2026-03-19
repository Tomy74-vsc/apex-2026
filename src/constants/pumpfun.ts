import { PublicKey } from '@solana/web3.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Program IDs
// ═══════════════════════════════════════════════════════════════════════════════

/** Programme principal Pump.fun (bonding curve + trade) */
export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/** Programme PumpSwap (AMM post-graduation) */
export const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

/** Programme de frais Pump.fun */
export const FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Comptes systeme
// ═══════════════════════════════════════════════════════════════════════════════

/** Compte global du programme Pump.fun (config on-chain) */
export const GLOBAL_ACCOUNT = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');

/** Destinataire des frais de trading */
export const FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');

/** Autorite de retrait (graduation) */
export const WITHDRAW_AUTHORITY = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');

/** PDA Event Authority — derive de ["__event_authority", PUMP_PROGRAM_ID] */
export const EVENT_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  PUMP_PROGRAM_ID,
)[0];

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Parametres de la bonding curve (bigint, lamports / raw token units)
// ═══════════════════════════════════════════════════════════════════════════════

/** Reserves virtuelles initiales en tokens (1.073B, 6 decimals) */
export const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n;

/** Reserves virtuelles initiales en SOL (30 SOL en lamports) */
export const INITIAL_VIRTUAL_SOL_RESERVES = 30_000_000_000n;

/** Reserves reelles initiales en tokens (793.1M tradeable, 6 decimals) */
export const INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;

/** Supply totale du token (1B, 6 decimals) */
export const TOKEN_TOTAL_SUPPLY = 1_000_000_000_000_000n;

/** Seuil de graduation en SOL reel (~85 SOL en lamports) */
export const GRADUATION_REAL_SOL_THRESHOLD = 85_000_000_000n;

/** Frais de trading (1.25% = 125 bps) */
export const FEE_BASIS_POINTS = 125n;

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Discriminateurs d'instructions (Anchor IDL)
// ═══════════════════════════════════════════════════════════════════════════════

/** Instruction BUY — acheter des tokens sur la bonding curve */
export const BUY_DISCRIMINATOR = new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]);

/** Instruction BUY exact SOL — acheter pour un montant exact de SOL */
export const BUY_EXACT_SOL_DISCRIMINATOR = new Uint8Array([56, 252, 116, 8, 158, 223, 205, 95]);

/** Instruction SELL — vendre des tokens sur la bonding curve */
export const SELL_DISCRIMINATOR = new Uint8Array([51, 230, 133, 164, 1, 127, 131, 173]);

/** Instruction CREATE — creer une nouvelle bonding curve */
export const CREATE_DISCRIMINATOR = new Uint8Array([24, 30, 200, 40, 5, 28, 7, 119]);

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Discriminateur & taille du compte BondingCurve
// ═══════════════════════════════════════════════════════════════════════════════

/** Discriminateur Anchor du compte BondingCurve (8 premiers bytes) */
export const BONDING_CURVE_DISCRIMINATOR = new Uint8Array([0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60]);

/**
 * Taille du payload BondingCurve sans discriminateur (82 bytes).
 * Layout:
 *   vTokenReserves  u64  @0x00
 *   vSolReserves    u64  @0x08
 *   rTokenReserves  u64  @0x10
 *   rSolReserves    u64  @0x18
 *   totalSupply     u64  @0x20
 *   complete        u8   @0x28
 *   creator         Pubkey @0x29
 *   isMayhemMode    u8   @0x49
 */
export const BONDING_CURVE_DATA_SIZE = 82;

/** Taille totale du compte on-chain (discriminateur 8 + data 82) */
export const BONDING_CURVE_ACCOUNT_SIZE = 90;

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Seuils strategiques (SOL, pas lamports — usage decision engine)
// ═══════════════════════════════════════════════════════════════════════════════

/** King of the Hill — ~32 SOL reel (~52% progress) */
export const KOTH_SOL_THRESHOLD = 32;

/** Debut de la zone d'entree optimale (~55% progress) */
export const ENTRY_ZONE_START_SOL = 35;

/** Fin de la zone d'entree optimale (~75% progress) */
export const ENTRY_ZONE_END_SOL = 55;

/** Seuil de graduation (~85 SOL reel) */
export const GRADUATION_SOL = 85;

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Constantes de timing (ms)
// ═══════════════════════════════════════════════════════════════════════════════

/** Intervalle de polling tier Cold (<25% progress) */
export const COLD_POLL_INTERVAL_MS = 60_000;

/** Intervalle de polling tier Warm (25-50% progress) */
export const WARM_POLL_INTERVAL_MS = 10_000;

/** Intervalle de polling tier Hot (>50% progress) — 5s to reduce RPC pressure */
export const HOT_POLL_INTERVAL_MS = 5_000;

/** TTL pour purger les courbes inactives (24h) */
export const STALE_CURVE_TTL_MS = 86_400_000;

/** Duree maximale de detention d'une position curve (2h) */
export const MAX_CURVE_HOLD_TIME_MS = 7_200_000;
