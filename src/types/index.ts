import { VersionedTransaction } from '@solana/web3.js';

/**
 * Timestamps 3 niveaux — Blueprint V2
 * t_source : horodatage de la source (blockTime Solana ou Date.now())
 * t_recv   : réception locale — capturé EN PREMIER dans chaque callback
 * t_act    : moment de la décision finale (rempli par DecisionCore)
 */
export interface EventTimestamps {
  t_source: number; // Unix ms
  t_recv: number; // Unix ms
  t_act?: number; // Unix ms — optionnel, rempli plus tard
}

/**
 * Latences calculées par DecisionCore
 * Stockées dans ScoredToken pour le Feature Store et le monitoring
 */
export interface DecisionLatency {
  detectionMs: number; // t_recv - t_source (latence réseau + propagation)
  guardMs: number; // durée Guard en ms
  scoringMs: number; // durée scoring en ms (2 décimales)
  totalMs: number; // t_act - t_source (latence totale perçue)
}

export interface TokenMetadata {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface MarketEvent extends EventTimestamps {
  token: TokenMetadata;
  poolId: string;
  initialLiquiditySol: number;
  initialPriceUsdc: number;
  timestamp: number; // gardé pour compatibilité = t_source
}

export interface SocialSignal {
  mint: string;
  ticker: string;
  platform: 'X' | 'Telegram';
  authorTrustScore: number; // 0-100
  followerCount: number;
  velocity30s: number; // Mentions par 30s
  sentiment: number; // -1 to 1
  rawMessage?: string; // Message brut (pour Telegram notamment)
  channelId?: string; // ID du canal/channel (pour Telegram notamment)
}

export interface SecurityReport {
  mint: string;
  isSafe: boolean;
  riskScore: number; // 0 (sûr) à 100 (rug)
  flags: string[];
  details: {
    mintRenounced: boolean;
    freezeDisabled: boolean;
    lpBurnedPercent: number;
    top10HoldersPercent: number;
    isHoneypot: boolean;
    liquiditySol?: number; // Liquidité SOL dans le pool (si trouvé)
    hasLiquidity?: boolean; // Pool de liquidité existe
  };
}

export interface ScoredToken extends MarketEvent {
  social: SocialSignal | null;
  security: SecurityReport;
  finalScore: number;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  latency?: DecisionLatency; // NOUVEAU — optionnel, non-breaking
}

export interface ExecutionBundle {
  transactions: VersionedTransaction[];
  jitoTipLamports: number;
  targetToken: string;
}