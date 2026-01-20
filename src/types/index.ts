import { VersionedTransaction } from '@solana/web3.js';

export interface TokenMetadata {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface MarketEvent {
  token: TokenMetadata;
  poolId: string;
  initialLiquiditySol: number;
  initialPriceUsdc: number;
  timestamp: number;
}

export interface SocialSignal {
  mint: string;
  ticker: string;
  platform: 'X' | 'Telegram';
  authorTrustScore: number; // 0-100
  followerCount: number;
  velocity30s: number; // Mentions par 30s
  sentiment: number; // -1 to 1
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
}

export interface ExecutionBundle {
  transactions: VersionedTransaction[];
  jitoTipLamports: number;
  targetToken: string;
}