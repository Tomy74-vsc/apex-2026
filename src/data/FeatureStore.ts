/**
 * FeatureStore — APEX-2026 Cold Path
 *
 * Stocke chaque décision du bot dans SQLite via bun:sqlite natif.
 * Fondation du dataset ML pour entraîner le modèle ONNX.
 *
 * Architecture buffer + flush :
 *   appendEvent() → buffer RAM → flush toutes les 5s → SQLite
 *   appendLabel() → direct (rare, pas de perf critique)
 *
 * Règle d'or : ce module ne throw jamais vers l'appelant.
 * Toute erreur = log interne + continue.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import type {
  TokenEventRecord,
  TokenLabelRecord,
  FeatureSnapshotRecord,
  TokenOutcomeRecord,
  ModelParamsRecord,
  CurveSnapshotRecord,
} from '../types/index.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 5_000; // flush toutes les 5 secondes
const FLUSH_BUFFER_MAX = 50; // flush si buffer dépasse 50 items
const DEFAULT_DB_PATH = './data/apex.db';

// ─── Schéma SQL ──────────────────────────────────────────────────────────────

const SCHEMA = `
-- Events : une ligne par décision du bot (append-only)
CREATE TABLE IF NOT EXISTS token_events (
  id              TEXT    PRIMARY KEY,
  mint            TEXT    NOT NULL,
  t_source        INTEGER NOT NULL,
  t_recv          INTEGER NOT NULL,
  t_act           INTEGER NOT NULL,
  features_json   TEXT    NOT NULL DEFAULT '[]',
  linear_score    REAL    NOT NULL,
  onnx_score      REAL,
  active_score    REAL    NOT NULL,
  shadow_mode     TEXT    NOT NULL DEFAULT 'linear_only',
  liquidity_sol   REAL    NOT NULL,
  risk_score      INTEGER NOT NULL,
  priority        TEXT    NOT NULL,
  decision        TEXT    NOT NULL,
  is_fast_check   INTEGER NOT NULL DEFAULT 0,
  detection_ms    REAL,
  guard_ms        REAL,
  scoring_ms      REAL,
  total_ms        REAL,
  created_at      INTEGER NOT NULL
);

-- Index pour les requêtes ML fréquentes
CREATE INDEX IF NOT EXISTS idx_token_events_mint       ON token_events(mint);
CREATE INDEX IF NOT EXISTS idx_token_events_decision   ON token_events(decision);
CREATE INDEX IF NOT EXISTS idx_token_events_created_at ON token_events(created_at);

-- Labels : retours réels post-trade (ajoutés par PriceTracker C2)
CREATE TABLE IF NOT EXISTS token_labels (
  mint        TEXT    NOT NULL,
  horizon_s   INTEGER NOT NULL,
  ret_log     REAL,
  drawdown    REAL,
  exec_ok     INTEGER,
  labeled_at  INTEGER NOT NULL,
  PRIMARY KEY (mint, horizon_s)
);

-- ═══════════════════════════════════════════════════════════════════════
-- V3 Feature Store — ML Feature Snapshots + Outcomes + Model Registry
-- ═══════════════════════════════════════════════════════════════════════

-- Full 12-dimensional feature vector snapshot per decision
CREATE TABLE IF NOT EXISTS feature_snapshots (
  id              TEXT    PRIMARY KEY,
  mint            TEXT    NOT NULL,
  timestamp_ms    INTEGER NOT NULL,

  -- Feature vector (12 dimensions — matches rust_core/src/types.rs FeatureVector)
  ofi             REAL    NOT NULL DEFAULT 0,
  hawkes_buy      REAL    NOT NULL DEFAULT 0,
  hawkes_sell     REAL    NOT NULL DEFAULT 0,
  hmm_state0      REAL    NOT NULL DEFAULT 0.25,
  hmm_state1      REAL    NOT NULL DEFAULT 0.25,
  hmm_state2      REAL    NOT NULL DEFAULT 0.25,
  hmm_state3      REAL    NOT NULL DEFAULT 0.25,
  nlp_score       REAL    NOT NULL DEFAULT 0,
  smart_money     REAL    NOT NULL DEFAULT 0,
  realized_vol    REAL    NOT NULL DEFAULT 0,
  liquidity_sol   REAL    NOT NULL DEFAULT 0,
  price_usdc      REAL    NOT NULL DEFAULT 0,

  -- Staleness: age of each feature in ms (for multi-source lag awareness)
  max_staleness_ms REAL   NOT NULL DEFAULT 0,
  source          TEXT    NOT NULL DEFAULT 'websocket',

  -- Pipeline latency
  latency_ms      REAL    NOT NULL DEFAULT 0,

  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feature_snapshots_mint       ON feature_snapshots(mint);
CREATE INDEX IF NOT EXISTS idx_feature_snapshots_ts         ON feature_snapshots(timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_feature_snapshots_created_at ON feature_snapshots(created_at);

-- Outcome labels: price change observed at T+5m and T+30m after a feature snapshot
CREATE TABLE IF NOT EXISTS token_outcomes (
  id                TEXT    PRIMARY KEY,
  feature_id        TEXT    NOT NULL UNIQUE,
  price_change_5m   REAL    NOT NULL DEFAULT 0,
  max_drawdown_5m   REAL    NOT NULL DEFAULT 0,
  volume_change_5m  REAL    NOT NULL DEFAULT 0,
  label             TEXT    NOT NULL DEFAULT 'NEUTRAL',
  price_change_30m  REAL,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (feature_id) REFERENCES feature_snapshots(id)
);

CREATE INDEX IF NOT EXISTS idx_token_outcomes_feature ON token_outcomes(feature_id);
CREATE INDEX IF NOT EXISTS idx_token_outcomes_label   ON token_outcomes(label);

-- Model parameter registry: tracks trained model versions
CREATE TABLE IF NOT EXISTS model_params (
  id          TEXT    PRIMARY KEY,
  model_type  TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  params_blob BLOB,
  metrics_json TEXT   NOT NULL DEFAULT '{}',
  is_active   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_params_type   ON model_params(model_type);
CREATE INDEX IF NOT EXISTS idx_model_params_active ON model_params(is_active);

-- ═══════════════════════════════════════════════════════════════════════
-- V3.1 Bonding Curve — Prediction Snapshots for ML training
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS curve_snapshots (
  id                    TEXT    PRIMARY KEY,
  mint                  TEXT    NOT NULL,
  timestamp_ms          INTEGER NOT NULL,

  -- Curve state
  progress              REAL    NOT NULL DEFAULT 0,
  real_sol_sol          REAL    NOT NULL DEFAULT 0,
  price_sol             REAL    NOT NULL DEFAULT 0,
  market_cap_sol        REAL    NOT NULL DEFAULT 0,
  tier                  TEXT    NOT NULL DEFAULT 'cold',
  trade_count           INTEGER NOT NULL DEFAULT 0,

  -- Prediction
  p_grad                REAL    NOT NULL DEFAULT 0,
  confidence            REAL    NOT NULL DEFAULT 0,
  breakeven             REAL    NOT NULL DEFAULT 0,
  action                TEXT    NOT NULL DEFAULT 'SKIP',
  veto_reason           TEXT,

  -- Velocity signals
  sol_per_minute_1m     REAL    NOT NULL DEFAULT 0,
  sol_per_minute_5m     REAL    NOT NULL DEFAULT 0,
  avg_trade_size_sol    REAL    NOT NULL DEFAULT 0,
  velocity_ratio        REAL    NOT NULL DEFAULT 0,

  -- Bot / wallet signals
  bot_transaction_ratio REAL    NOT NULL DEFAULT 0,
  smart_money_buyer_cnt INTEGER NOT NULL DEFAULT 0,
  creator_is_selling    INTEGER NOT NULL DEFAULT 0,
  fresh_wallet_ratio    REAL    NOT NULL DEFAULT 0,

  social_score          REAL    NOT NULL DEFAULT 0,

  -- Latency
  prediction_ms         REAL    NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_curve_snapshots_mint       ON curve_snapshots(mint);
CREATE INDEX IF NOT EXISTS idx_curve_snapshots_ts         ON curve_snapshots(timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_curve_snapshots_action     ON curve_snapshots(action);
CREATE INDEX IF NOT EXISTS idx_curve_snapshots_created_at ON curve_snapshots(created_at);

-- ═══════════════════════════════════════════════════════════════════════
-- V3.1 Curve Outcomes — Graduation labeling for ML training
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS curve_outcomes (
  mint              TEXT    PRIMARY KEY,
  graduated         INTEGER NOT NULL DEFAULT 0,
  final_progress    REAL    NOT NULL DEFAULT 0,
  final_sol         REAL    NOT NULL DEFAULT 0,
  duration_s        REAL    NOT NULL DEFAULT 0,
  eviction_reason   TEXT,
  snapshots_count   INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_curve_outcomes_graduated ON curve_outcomes(graduated);

-- V3.1 Phase A — Open curve positions (crash recovery, debounced upserts from PositionManager)
CREATE TABLE IF NOT EXISTS open_curve_positions (
  mint          TEXT    PRIMARY KEY,
  payload_json  TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Whale / smart-money registry (seed + outcome enrichment)
CREATE TABLE IF NOT EXISTS whale_wallets (
  address           TEXT    PRIMARY KEY,
  label             TEXT    NOT NULL DEFAULT 'unknown',
  trust_score       REAL    NOT NULL DEFAULT 0.5,
  tokens_bought     INTEGER NOT NULL DEFAULT 0,
  tokens_graduated  INTEGER NOT NULL DEFAULT 0,
  win_rate          REAL    NOT NULL DEFAULT 0,
  last_seen_ms      INTEGER NOT NULL DEFAULT 0,
  discovered_via    TEXT    NOT NULL DEFAULT 'manual',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whale_wallets_trust ON whale_wallets(trust_score);
`;

// ─── Classe principale ────────────────────────────────────────────────────────

export class FeatureStore {
  private db: Database;
  private buffer: TokenEventRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isClosed = false;

  private stats = {
    buffered: 0,
    flushed: 0,
    errors: 0,
    lastFlush: 0,
  };

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    try {
      const lastSlash = dbPath.lastIndexOf('/');
      const dir = lastSlash === -1 ? '' : dbPath.substring(0, lastSlash);
      if (dir) mkdirSync(dir, { recursive: true });
    } catch {
      // ignore mkdir errors
    }

    this.db = new Database(dbPath, { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run(SCHEMA);
    this.migrateCurveSnapshotsSocialScore();

    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);

    console.log(`✅ [FeatureStore] Initialisé → ${dbPath}`);
  }

  /** Same bun:sqlite connection (WAL) — for WhaleWalletDB and extensions. */
  getSqliteHandle(): Database {
    return this.db;
  }

  /** DBs créés avant social_score : ALTER TABLE idempotent. */
  private migrateCurveSnapshotsSocialScore(): void {
    try {
      const cols = this.db.prepare('PRAGMA table_info(curve_snapshots)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'social_score')) {
        this.db.run('ALTER TABLE curve_snapshots ADD COLUMN social_score REAL NOT NULL DEFAULT 0');
        console.log('✅ [FeatureStore] Migration curve_snapshots.social_score');
      }
    } catch {
      /* cold path */
    }
  }

  // ─── API publique ───────────────────────────────────────────────────────────

  appendEvent(record: TokenEventRecord): void {
    if (this.isClosed) return;
    try {
      this.buffer.push(record);
      this.stats.buffered += 1;
      if (this.buffer.length >= FLUSH_BUFFER_MAX) {
        this.flush().catch(() => {});
      }
    } catch (err) {
      this.stats.errors += 1;
      console.warn(`⚠️  [FeatureStore] appendEvent error: ${err}`);
    }
  }

  appendLabel(label: TokenLabelRecord): void {
    if (this.isClosed) return;
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO token_labels
          (mint, horizon_s, ret_log, drawdown, exec_ok, labeled_at)
        VALUES
          (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        label.mint,
        label.horizonS,
        label.retLog,
        label.drawdown,
        label.execOk,
        label.labeledAt,
      );
    } catch (err) {
      this.stats.errors += 1;
      console.warn(`⚠️  [FeatureStore] appendLabel error: ${err}`);
    }
  }

  queryEvents(opts: {
    since?: number;
    decision?: 'SNIPE' | 'SKIP';
    limit?: number;
  } = {}): TokenEventRecord[] {
    try {
      let sql = 'SELECT * FROM token_events WHERE 1=1';
      const params: (string | number | null)[] = [];

      if (opts.since !== undefined) {
        sql += ' AND created_at >= ?';
        params.push(opts.since);
      }
      if (opts.decision) {
        sql += ' AND decision = ?';
        params.push(opts.decision);
      }
      sql += ' ORDER BY created_at DESC';
      if (opts.limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(opts.limit);
      }

      return this.db.prepare(sql).all(...params) as TokenEventRecord[];
    } catch (err) {
      console.warn(`⚠️  [FeatureStore] queryEvents error: ${err}`);
      return [];
    }
  }

  queryLabeled(
    horizonS: number = 30,
  ): Array<TokenEventRecord & { label: TokenLabelRecord }> {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT
          e.*,
          l.ret_log,
          l.drawdown,
          l.exec_ok,
          l.labeled_at,
          l.horizon_s
        FROM token_events e
        INNER JOIN token_labels l ON e.mint = l.mint AND l.horizon_s = ?
        ORDER BY e.created_at DESC
      `,
        )
        .all(horizonS) as Array<Record<string, unknown>>;

      return rows.map((row) => ({
        ...(row as unknown as TokenEventRecord),
        label: {
          mint: row.mint as string,
          horizonS: row.horizon_s as number,
          retLog: (row.ret_log as number | null) ?? null,
          drawdown: (row.drawdown as number | null) ?? null,
          execOk: (row.exec_ok as number | null) ?? null,
          labeledAt: row.labeled_at as number,
        },
      }));
    } catch (err) {
      console.warn(`⚠️  [FeatureStore] queryLabeled error: ${err}`);
      return [];
    }
  }

  getStats() {
    return {
      ...this.stats,
      bufferSize: this.buffer.length,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V3 Feature Store API — Feature Snapshots, Outcomes, Model Registry
  // ═══════════════════════════════════════════════════════════════════════════

  appendFeatureSnapshot(snap: FeatureSnapshotRecord): void {
    if (this.isClosed) return;
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO feature_snapshots (
          id, mint, timestamp_ms,
          ofi, hawkes_buy, hawkes_sell,
          hmm_state0, hmm_state1, hmm_state2, hmm_state3,
          nlp_score, smart_money, realized_vol, liquidity_sol, price_usdc,
          max_staleness_ms, source, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snap.id,
        snap.mint,
        snap.timestampMs,
        snap.ofi,
        snap.hawkesBuy,
        snap.hawkesSell,
        snap.hmmState0,
        snap.hmmState1,
        snap.hmmState2,
        snap.hmmState3,
        snap.nlpScore,
        snap.smartMoney,
        snap.realizedVol,
        snap.liquiditySol,
        snap.priceUsdc,
        snap.maxStalenessMs,
        snap.source,
        snap.latencyMs,
        snap.createdAt,
      );
    } catch (err) {
      this.stats.errors += 1;
      console.warn(`⚠️  [FeatureStore] appendFeatureSnapshot error: ${err}`);
    }
  }

  appendOutcome(outcome: TokenOutcomeRecord): void {
    if (this.isClosed) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO token_outcomes (
          id, feature_id, price_change_5m, max_drawdown_5m, volume_change_5m,
          label, price_change_30m, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        outcome.id,
        outcome.featureId,
        outcome.priceChange5m,
        outcome.maxDrawdown5m,
        outcome.volumeChange5m,
        outcome.label,
        outcome.priceChange30m,
        outcome.createdAt,
      );
    } catch (err) {
      this.stats.errors += 1;
      console.warn(`⚠️  [FeatureStore] appendOutcome error: ${err}`);
    }
  }

  queryFeatureSnapshots(opts: {
    since?: number;
    mint?: string;
    limit?: number;
  } = {}): FeatureSnapshotRecord[] {
    try {
      let sql = 'SELECT * FROM feature_snapshots WHERE 1=1';
      const params: (string | number)[] = [];

      if (opts.since !== undefined) {
        sql += ' AND timestamp_ms >= ?';
        params.push(opts.since);
      }
      if (opts.mint) {
        sql += ' AND mint = ?';
        params.push(opts.mint);
      }
      sql += ' ORDER BY timestamp_ms DESC';
      if (opts.limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(opts.limit);
      }

      const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: r.id as string,
        mint: r.mint as string,
        timestampMs: r.timestamp_ms as number,
        ofi: r.ofi as number,
        hawkesBuy: r.hawkes_buy as number,
        hawkesSell: r.hawkes_sell as number,
        hmmState0: r.hmm_state0 as number,
        hmmState1: r.hmm_state1 as number,
        hmmState2: r.hmm_state2 as number,
        hmmState3: r.hmm_state3 as number,
        nlpScore: r.nlp_score as number,
        smartMoney: r.smart_money as number,
        realizedVol: r.realized_vol as number,
        liquiditySol: r.liquidity_sol as number,
        priceUsdc: r.price_usdc as number,
        maxStalenessMs: r.max_staleness_ms as number,
        source: r.source as FeatureSnapshotRecord['source'],
        latencyMs: r.latency_ms as number,
        createdAt: r.created_at as number,
      }));
    } catch (err) {
      console.warn(`⚠️  [FeatureStore] queryFeatureSnapshots error: ${err}`);
      return [];
    }
  }

  queryLabeledSnapshots(): Array<FeatureSnapshotRecord & { outcome: TokenOutcomeRecord }> {
    try {
      const rows = this.db.prepare(`
        SELECT
          s.*, o.id AS outcome_id,
          o.price_change_5m, o.max_drawdown_5m, o.volume_change_5m,
          o.label, o.price_change_30m, o.created_at AS outcome_created_at
        FROM feature_snapshots s
        INNER JOIN token_outcomes o ON s.id = o.feature_id
        ORDER BY s.timestamp_ms DESC
      `).all() as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        id: r.id as string,
        mint: r.mint as string,
        timestampMs: r.timestamp_ms as number,
        ofi: r.ofi as number,
        hawkesBuy: r.hawkes_buy as number,
        hawkesSell: r.hawkes_sell as number,
        hmmState0: r.hmm_state0 as number,
        hmmState1: r.hmm_state1 as number,
        hmmState2: r.hmm_state2 as number,
        hmmState3: r.hmm_state3 as number,
        nlpScore: r.nlp_score as number,
        smartMoney: r.smart_money as number,
        realizedVol: r.realized_vol as number,
        liquiditySol: r.liquidity_sol as number,
        priceUsdc: r.price_usdc as number,
        maxStalenessMs: r.max_staleness_ms as number,
        source: r.source as FeatureSnapshotRecord['source'],
        latencyMs: r.latency_ms as number,
        createdAt: r.created_at as number,
        outcome: {
          id: r.outcome_id as string,
          featureId: r.id as string,
          priceChange5m: r.price_change_5m as number,
          maxDrawdown5m: r.max_drawdown_5m as number,
          volumeChange5m: r.volume_change_5m as number,
          label: r.label as TokenOutcomeRecord['label'],
          priceChange30m: (r.price_change_30m as number | null) ?? null,
          createdAt: r.outcome_created_at as number,
        },
      }));
    } catch (err) {
      console.warn(`⚠️  [FeatureStore] queryLabeledSnapshots error: ${err}`);
      return [];
    }
  }

  // ─── Model Registry ────────────────────────────────────────────────────────

  saveModelParams(params: ModelParamsRecord): void {
    if (this.isClosed) return;
    try {
      if (params.isActive) {
        this.db.prepare(
          `UPDATE model_params SET is_active = 0 WHERE model_type = ?`,
        ).run(params.modelType);
      }
      this.db.prepare(`
        INSERT OR REPLACE INTO model_params
          (id, model_type, version, params_blob, metrics_json, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.id,
        params.modelType,
        params.version,
        params.paramsBlob,
        params.metricsJson,
        params.isActive ? 1 : 0,
        params.createdAt,
      );
    } catch (err) {
      this.stats.errors += 1;
      console.warn(`⚠️  [FeatureStore] saveModelParams error: ${err}`);
    }
  }

  getActiveModel(modelType: string): ModelParamsRecord | null {
    try {
      const row = this.db.prepare(
        `SELECT * FROM model_params WHERE model_type = ? AND is_active = 1 LIMIT 1`,
      ).get(modelType) as Record<string, unknown> | null;

      if (!row) return null;
      return {
        id: row.id as string,
        modelType: row.model_type as ModelParamsRecord['modelType'],
        version: row.version as number,
        paramsBlob: row.params_blob as Uint8Array | null,
        metricsJson: row.metrics_json as string,
        isActive: true,
        createdAt: row.created_at as number,
      };
    } catch (err) {
      console.warn(`⚠️  [FeatureStore] getActiveModel error: ${err}`);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V3.1 Curve Snapshots — Bonding Curve Prediction Logging
  // ═══════════════════════════════════════════════════════════════════════════

  appendCurveSnapshot(snap: CurveSnapshotRecord): void {
    if (this.isClosed) return;
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO curve_snapshots (
          id, mint, timestamp_ms,
          progress, real_sol_sol, price_sol, market_cap_sol, tier, trade_count,
          p_grad, confidence, breakeven, action, veto_reason,
          sol_per_minute_1m, sol_per_minute_5m, avg_trade_size_sol, velocity_ratio,
          bot_transaction_ratio, smart_money_buyer_cnt, creator_is_selling, fresh_wallet_ratio,
          social_score,
          prediction_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snap.id, snap.mint, snap.timestampMs,
        snap.progress, snap.realSolSOL, snap.priceSOL, snap.marketCapSOL, snap.tier, snap.tradeCount,
        snap.pGrad, snap.confidence, snap.breakeven, snap.action, snap.vetoReason,
        snap.solPerMinute1m, snap.solPerMinute5m, snap.avgTradeSizeSOL, snap.velocityRatio,
        snap.botTransactionRatio, snap.smartMoneyBuyerCount, snap.creatorIsSelling, snap.freshWalletRatio,
        snap.socialScore,
        snap.predictionMs, snap.createdAt,
      );
    } catch (err) {
      this.stats.errors += 1;
      console.warn(`⚠️  [FeatureStore] appendCurveSnapshot error: ${err}`);
    }
  }

  queryCurveSnapshots(opts: {
    since?: number;
    mint?: string;
    action?: string;
    limit?: number;
  } = {}): CurveSnapshotRecord[] {
    try {
      let sql = 'SELECT * FROM curve_snapshots WHERE 1=1';
      const params: (string | number)[] = [];

      if (opts.since !== undefined) {
        sql += ' AND timestamp_ms >= ?';
        params.push(opts.since);
      }
      if (opts.mint) {
        sql += ' AND mint = ?';
        params.push(opts.mint);
      }
      if (opts.action) {
        sql += ' AND action = ?';
        params.push(opts.action);
      }
      sql += ' ORDER BY timestamp_ms DESC';
      if (opts.limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(opts.limit);
      }

      const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: r.id as string,
        mint: r.mint as string,
        timestampMs: r.timestamp_ms as number,
        progress: r.progress as number,
        realSolSOL: r.real_sol_sol as number,
        priceSOL: r.price_sol as number,
        marketCapSOL: r.market_cap_sol as number,
        tier: r.tier as CurveSnapshotRecord['tier'],
        tradeCount: r.trade_count as number,
        pGrad: r.p_grad as number,
        confidence: r.confidence as number,
        breakeven: r.breakeven as number,
        action: r.action as string,
        vetoReason: r.veto_reason as string | null,
        solPerMinute1m: r.sol_per_minute_1m as number,
        solPerMinute5m: r.sol_per_minute_5m as number,
        avgTradeSizeSOL: r.avg_trade_size_sol as number,
        velocityRatio: r.velocity_ratio as number,
        botTransactionRatio: r.bot_transaction_ratio as number,
        smartMoneyBuyerCount: r.smart_money_buyer_cnt as number,
        creatorIsSelling: r.creator_is_selling as number,
        freshWalletRatio: r.fresh_wallet_ratio as number,
        socialScore: (r.social_score as number | undefined) ?? 0,
        predictionMs: r.prediction_ms as number,
        createdAt: r.created_at as number,
      }));
    } catch (err) {
      console.warn(`⚠️  [FeatureStore] queryCurveSnapshots error: ${err}`);
      return [];
    }
  }

  getCurveSnapshotCount(): number {
    try {
      const row = this.db.prepare(
        'SELECT COUNT(*) as cnt FROM curve_snapshots',
      ).get() as { cnt: number } | null;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Label a mint's outcome (graduated or evicted).
   * Called once per mint when CurveTracker emits 'graduated' or 'evicted'.
   */
  labelCurveOutcome(opts: {
    mint: string;
    graduated: boolean;
    finalProgress: number;
    finalSol: number;
    durationS: number;
    evictionReason?: string;
  }): void {
    if (this.isClosed) return;
    try {
      const snapCount = this.db.prepare(
        'SELECT COUNT(*) as cnt FROM curve_snapshots WHERE mint = ?',
      ).get(opts.mint) as { cnt: number } | null;

      this.db.prepare(`
        INSERT OR REPLACE INTO curve_outcomes (
          mint, graduated, final_progress, final_sol, duration_s,
          eviction_reason, snapshots_count, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        opts.mint,
        opts.graduated ? 1 : 0,
        opts.finalProgress,
        opts.finalSol,
        opts.durationS,
        opts.evictionReason ?? null,
        snapCount?.cnt ?? 0,
        Date.now(),
        Date.now(),
      );

      const emoji = opts.graduated ? '🎓' : '💀';
      console.log(
        `${emoji} [FeatureStore] Outcome: ${opts.mint.slice(0, 8)} | ` +
        `graduated=${opts.graduated} | progress=${(opts.finalProgress * 100).toFixed(1)}% | ` +
        `${opts.finalSol.toFixed(2)} SOL | ${opts.durationS.toFixed(0)}s | snapshots=${snapCount?.cnt ?? 0}`,
      );
    } catch (err) {
      console.warn(`⚠️  [FeatureStore] labelCurveOutcome error: ${err}`);
    }
  }

  /**
   * Export curve snapshots joined with outcomes for ML training.
   * Returns only mints that have a resolved outcome.
   */
  queryLabeledCurveData(limit = 50_000): Array<Record<string, unknown>> {
    try {
      return this.db.prepare(`
        SELECT
          s.mint, s.timestamp_ms, s.progress, s.real_sol_sol, s.price_sol,
          s.market_cap_sol, s.tier, s.trade_count,
          s.p_grad, s.confidence, s.breakeven, s.action,
          s.sol_per_minute_1m, s.sol_per_minute_5m,
          s.avg_trade_size_sol, s.velocity_ratio,
          s.bot_transaction_ratio, s.smart_money_buyer_cnt,
          s.creator_is_selling, s.fresh_wallet_ratio,
          s.social_score,
          o.graduated, o.final_progress, o.final_sol, o.duration_s
        FROM curve_snapshots s
        INNER JOIN curve_outcomes o ON s.mint = o.mint
        ORDER BY s.timestamp_ms DESC
        LIMIT ?
      `).all(limit) as Array<Record<string, unknown>>;
    } catch (err) {
      console.warn(`⚠️  [FeatureStore] queryLabeledCurveData error: ${err}`);
      return [];
    }
  }

  getCurveOutcomeCount(): { total: number; graduated: number; evicted: number } {
    try {
      const row = this.db.prepare(`
        SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN graduated = 1 THEN 1 ELSE 0 END), 0) as graduated,
          COALESCE(SUM(CASE WHEN graduated = 0 THEN 1 ELSE 0 END), 0) as evicted
        FROM curve_outcomes
      `).get() as { total: number; graduated: number; evicted: number } | null;
      return row ?? { total: 0, graduated: 0, evicted: 0 };
    } catch {
      return { total: 0, graduated: 0, evicted: 0 };
    }
  }

  /** Persist one open curve position (PositionManager debounced / shutdown flush). */
  upsertOpenCurvePosition(mint: string, payloadJson: string): void {
    if (this.isClosed) return;
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO open_curve_positions (mint, payload_json, updated_at) VALUES (?, ?, ?)`,
        )
        .run(mint, payloadJson, Date.now());
    } catch (err) {
      this.stats.errors += 1;
      console.warn(`⚠️  [FeatureStore] upsertOpenCurvePosition error: ${err}`);
    }
  }

  deleteOpenCurvePosition(mint: string): void {
    if (this.isClosed) return;
    try {
      this.db.prepare(`DELETE FROM open_curve_positions WHERE mint = ?`).run(mint);
    } catch (err) {
      this.stats.errors += 1;
      console.warn(`⚠️  [FeatureStore] deleteOpenCurvePosition error: ${err}`);
    }
  }

  loadOpenCurvePositions(): Array<{ mint: string; payload_json: string }> {
    try {
      return this.db
        .prepare(`SELECT mint, payload_json FROM open_curve_positions`)
        .all() as Array<{ mint: string; payload_json: string }>;
    } catch (err) {
      console.warn(`⚠️  [FeatureStore] loadOpenCurvePositions error: ${err}`);
      return [];
    }
  }

  getSnapshotCount(): number {
    try {
      const row = this.db.prepare(
        'SELECT COUNT(*) as cnt FROM feature_snapshots',
      ).get() as { cnt: number } | null;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  async close(): Promise<void> {
    this.isClosed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    this.db.close();
    console.log(
      `✅ [FeatureStore] Fermé — ${this.stats.flushed} events persistés`,
    );
  }

  // ─── Flush interne ──────────────────────────────────────────────────────────

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);

    try {
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO token_events (
          id, mint, t_source, t_recv, t_act,
          features_json, linear_score, onnx_score, active_score, shadow_mode,
          liquidity_sol, risk_score, priority, decision, is_fast_check,
          detection_ms, guard_ms, scoring_ms, total_ms, created_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?
        )
      `);

      const insertAll = this.db.transaction(
        (records: TokenEventRecord[]) => {
          for (const r of records) {
            insert.run(
              r.id,
              r.mint,
              r.t_source,
              r.t_recv,
              r.t_act,
              r.featuresJson,
              r.linearScore,
              r.onnxScore,
              r.activeScore,
              r.shadowMode,
              r.liquiditySol,
              r.riskScore,
              r.priority,
              r.decision,
              r.isFastCheck ? 1 : 0,
              r.detectionMs,
              r.guardMs,
              r.scoringMs,
              r.totalMs,
              r.createdAt,
            );
          }
        },
      );

      insertAll(batch);
      this.stats.flushed += batch.length;
      this.stats.lastFlush = Date.now();
    } catch (err) {
      this.buffer.unshift(...batch);
      this.stats.errors += 1;
      console.warn(
        `⚠️  [FeatureStore] flush error (${batch.length} items requeued): ${err}`,
      );
    }
  }
}

// ─── Singleton pour usage dans app.ts ────────────────────────────────────────

let _instance: FeatureStore | null = null;

export function getFeatureStore(dbPath?: string): FeatureStore {
  if (!_instance) {
    const path = dbPath ?? process.env.FEATURE_STORE_PATH ?? DEFAULT_DB_PATH;
    _instance = new FeatureStore(path);
  }
  return _instance;
}

