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
  latency?: DecisionLatency;
  aiDecision?: {
    action: 'BUY' | 'SKIP';
    aiScore: number;
    confidence: number;
    regime: string;
    kellyFraction: number;
    positionSol: number;
    latencyMs: number;
  };
}

export interface ExecutionBundle {
  transactions: VersionedTransaction[];
  jitoTipLamports: number;
  targetToken: string;
}

/**
 * Enregistrement d'un événement token dans le Feature Store
 * Stocké à chaque tokenScored ou readyToSnipe en prod
 */
export interface TokenEventRecord {
  id: string; // cuid / uuid généré côté TS
  mint: string;
  // Timestamps Blueprint V2
  t_source: number; // Unix ms
  t_recv: number; // Unix ms
  t_act: number; // Unix ms — moment de la décision
  // Features snapshot — JSON sérialisé d'un float[]
  // Vide pour l'instant (sera rempli par B1 FeatureExtractor)
  featuresJson: string; // '[]' par défaut jusqu'à B1
  // Scores
  linearScore: number;
  onnxScore: number | null; // null jusqu'à B2 ShadowModel
  activeScore: number;
  shadowMode: string; // 'linear_only' | 'shadow' | 'live'
  // Contexte marché
  liquiditySol: number;
  riskScore: number;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  decision: 'SNIPE' | 'SKIP'; // décision finale
  isFastCheck: boolean;
  // Latences (depuis DecisionLatency)
  detectionMs: number | null;
  guardMs: number | null;
  scoringMs: number | null;
  totalMs: number | null;
  // Metadata
  createdAt: number; // Unix ms — Date.now() au moment d'append
}

/**
 * Label ML ajouté par PriceTracker (C2) après l'événement
 * Null = pas encore labellisé
 */
export interface TokenLabelRecord {
  mint: string;
  horizonS: number; // 5 | 30 | 120 | 600
  retLog: number | null; // log return = log(price_t / price_0)
  drawdown: number | null; // max drawdown dans la fenêtre
  execOk: number | null; // 1 = landing réussi, 0 = fail, null = skip
  labeledAt: number; // Unix ms
}

// ═══════════════════════════════════════════════════════════════════════════
// V3 Feature Store — Feature Snapshots, Outcomes, Model Registry
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Full 12-dimensional feature vector snapshot.
 * Matches rust_core/src/types.rs FeatureVector layout.
 */
export interface FeatureSnapshotRecord {
  id: string;
  mint: string;
  timestampMs: number;

  // 12 features (order matches FeatureIndex in bridge/types.ts)
  ofi: number;
  hawkesBuy: number;
  hawkesSell: number;
  hmmState0: number; // P(Accumulation)
  hmmState1: number; // P(Trending)
  hmmState2: number; // P(Mania)
  hmmState3: number; // P(Distribution)
  nlpScore: number;
  smartMoney: number;
  realizedVol: number;
  liquiditySol: number;
  priceUsdc: number;

  // Metadata
  maxStalenessMs: number;
  source: 'grpc' | 'websocket' | 'pump' | 'telegram';
  latencyMs: number;
  createdAt: number;
}

/**
 * Outcome observed after a feature snapshot (T+5m, T+30m).
 */
export interface TokenOutcomeRecord {
  id: string;
  featureId: string;
  priceChange5m: number;
  maxDrawdown5m: number;
  volumeChange5m: number;
  label: 'WIN' | 'LOSS' | 'NEUTRAL';
  priceChange30m: number | null;
  createdAt: number;
}

/**
 * Trained model parameters stored in the registry.
 */
export interface ModelParamsRecord {
  id: string;
  modelType: 'hmm' | 'hawkes' | 'tft' | 'rl';
  version: number;
  paramsBlob: Uint8Array | null;
  metricsJson: string;
  isActive: boolean;
  createdAt: number;
}