import { EventEmitter } from 'events';
import { getFeatureStore } from '../../data/FeatureStore.js';
import type { TrackedCurve } from '../../types/bonding-curve.js';

const PERSIST_DEBOUNCE_MS = 500;
/** v2: same schema; bump forces re-save after spot-price scale fix (SOL/raw vs lamports/raw). */
const STORED_VERSION = 2 as const;

interface StoredCurvePositionV1 {
  v: 1 | typeof STORED_VERSION;
  id: string;
  mint: string;
  entryTimestamp: number;
  originalEntrySol: number;
  cumSolReceived: number;
  initialTokenAmount: string;
  remainingTokens: string;
  entryProgress: number;
  entryPriceSOL: number;
  entryMarketCapSOL: number;
  entryPGrad: number;
  entryBreakeven: number;
  currentPriceSOL: number;
  currentProgress: number;
  currentRealSolSOL: number;
  currentMarketCapSOL: number;
  lastUpdated: number;
  peakPriceSOL: number;
  /** If CLOSING at crash, reopen as OPEN so ExitEngine can retry. */
  persistedStatus?: 'OPEN' | 'CLOSING';
}

function persistEnabled(): boolean {
  return process.env.CURVE_POSITION_PERSIST !== '0';
}

export type CurvePositionStatus = 'OPEN' | 'CLOSING' | 'CLOSED';

export interface CurvePosition {
  id: string;
  mint: string;
  entryTimestamp: number;
  /** SOL spent on the opening buy (immutable). */
  originalEntrySol: number;
  /** SOL already received from partial sells (lamports path aggregated as SOL). */
  cumSolReceived: number;
  initialTokenAmount: bigint;
  remainingTokens: bigint;
  entryProgress: number;
  entryPriceSOL: number;
  entryMarketCapSOL: number;
  entryPGrad: number;
  entryBreakeven: number;
  currentPriceSOL: number;
  currentProgress: number;
  currentRealSolSOL: number;
  currentMarketCapSOL: number;
  lastUpdated: number;
  unrealizedPnlSOL: number;
  unrealizedPnlPct: number;
  peakPriceSOL: number;
  peakPnlPct: number;
  maxDrawdownFromPeakPct: number;
  status: CurvePositionStatus;
  exitReason: string | null;
  exitTimestamp: number | null;
  exitSolReceived: number | null;
  realizedPnlSOL: number | null;
  realizedPnlPct: number | null;
  holdDurationS: number | null;
}

export interface PortfolioSummary {
  openCount: number;
  totalInvested: number;
  totalUnrealizedPnl: number;
  totalUnrealizedPnlPct: number;
  totalRealizedPnl: number;
  winRate: number;
  avgHoldDurationS: number;
  avgPnlPct: number;
  bestTrade: CurvePosition | null;
  worstTrade: CurvePosition | null;
}

const MAX_CLOSED = 500;

let singleton: PositionManager | null = null;

export function getPositionManager(): PositionManager {
  if (!singleton) {
    singleton = new PositionManager();
  }
  return singleton;
}

function numTokens(b: bigint): number {
  const n = Number(b);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Ancien bug: `calcPricePerToken` renvoyait lamports / unité brute (~1e-5–1e-1).
 * Spot correct = SOL / unité brute (~1e-14–1e-10 sur pump.fun). On auto-répare RAM + SQLite restauré.
 */
const LEGACY_LAMPORTS_PER_RAW_FLOOR = 1e-8;
const LAMPORTS_PER_SOL_F64 = 1e9;

function normalizeLegacySpotPrices(p: CurvePosition): void {
  if (p.entryPriceSOL > LEGACY_LAMPORTS_PER_RAW_FLOOR) {
    p.entryPriceSOL /= LAMPORTS_PER_SOL_F64;
  }
  if (p.currentPriceSOL > LEGACY_LAMPORTS_PER_RAW_FLOOR) {
    p.currentPriceSOL /= LAMPORTS_PER_SOL_F64;
  }
  if (p.peakPriceSOL > LEGACY_LAMPORTS_PER_RAW_FLOOR) {
    p.peakPriceSOL /= LAMPORTS_PER_SOL_F64;
  }
}

/**
 * In-memory position book. Hot path `updatePosition`: O(1) Map, zero I/O.
 */
export class PositionManager extends EventEmitter {
  private readonly open: Map<string, CurvePosition> = new Map();
  private readonly closed: CurvePosition[] = [];
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  openPosition(
    mint: string,
    entrySol: number,
    entryTokens: bigint,
    curve: TrackedCurve,
    pGrad: number,
    breakeven: number,
  ): CurvePosition {
    const t0 = performance.now();
    const price = curve.priceSOL;
    const pos: CurvePosition = {
      id: crypto.randomUUID(),
      mint,
      entryTimestamp: Date.now(),
      originalEntrySol: entrySol,
      cumSolReceived: 0,
      initialTokenAmount: entryTokens,
      remainingTokens: entryTokens,
      entryProgress: curve.progress,
      entryPriceSOL: price,
      entryMarketCapSOL: curve.marketCapSOL,
      entryPGrad: pGrad,
      entryBreakeven: breakeven,
      currentPriceSOL: price,
      currentProgress: curve.progress,
      currentRealSolSOL: curve.realSolSOL,
      currentMarketCapSOL: curve.marketCapSOL,
      lastUpdated: Date.now(),
      unrealizedPnlSOL: 0,
      unrealizedPnlPct: 0,
      peakPriceSOL: price,
      peakPnlPct: 0,
      maxDrawdownFromPeakPct: 0,
      status: 'OPEN',
      exitReason: null,
      exitTimestamp: null,
      exitSolReceived: null,
      realizedPnlSOL: null,
      realizedPnlPct: null,
      holdDurationS: null,
    };
    this.recomputePnl(pos);
    this.open.set(mint, pos);
    console.log(
      `💰 [PositionManager] OPENED ${mint.slice(0, 8)}… | ${entrySol.toFixed(4)} SOL | progress=${(curve.progress * 100).toFixed(1)}% | ⏱️${(performance.now() - t0).toFixed(2)}ms`,
    );
    this.emit('positionOpened', pos);
    this.schedulePersistOpenRows();
    return pos;
  }

  markClosing(mint: string): boolean {
    const p = this.open.get(mint);
    if (!p || p.status !== 'OPEN') return false;
    p.status = 'CLOSING';
    this.schedulePersistOpenRows();
    return true;
  }

  /** If graduation exit aborted before sells, return to OPEN so ExitEngine can retry. */
  abortClosing(mint: string): void {
    const p = this.open.get(mint);
    if (p?.status === 'CLOSING') {
      p.status = 'OPEN';
      this.schedulePersistOpenRows();
    }
  }

  updatePosition(mint: string, curve: TrackedCurve): CurvePosition | null {
    const pos = this.open.get(mint);
    if (!pos || (pos.status !== 'OPEN' && pos.status !== 'CLOSING')) return null;

    pos.currentPriceSOL = curve.priceSOL;
    pos.currentProgress = curve.progress;
    pos.currentRealSolSOL = curve.realSolSOL;
    pos.currentMarketCapSOL = curve.marketCapSOL;
    pos.lastUpdated = Date.now();

    this.recomputePnl(pos);
    this.emit('positionUpdated', pos);
    return pos;
  }

  /**
   * Partial sell while OPEN/CLOSING: update tokens + cumulative SOL in.
   */
  applyPartialExit(mint: string, tokensSold: bigint, solReceived: number): CurvePosition | null {
    const pos = this.open.get(mint);
    if (!pos || (pos.status !== 'OPEN' && pos.status !== 'CLOSING')) return null;
    if (tokensSold <= 0n || solReceived < 0) return pos;

    pos.cumSolReceived += solReceived;
    pos.remainingTokens = pos.remainingTokens > tokensSold ? pos.remainingTokens - tokensSold : 0n;

    if (pos.remainingTokens === 0n) {
      return this.finishClose(pos, 'partial_flat', pos.cumSolReceived);
    }

    this.recomputePnl(pos);
    this.emit('positionUpdated', pos);
    this.schedulePersistOpenRows();
    return pos;
  }

  /** Full total SOL received (including any prior partials already in cumSolReceived). */
  closePosition(mint: string, reason: string, totalSolReceived: number): CurvePosition | null {
    const pos = this.open.get(mint);
    if (!pos) return null;
    return this.finishClose(pos, reason, totalSolReceived);
  }

  /** Prefer hot path from app: PnL = originalEntrySol vs cumSolReceived + last leg. */
  closeWithFinalLeg(mint: string, reason: string, finalLegSol: number): CurvePosition | null {
    const pos = this.open.get(mint);
    if (!pos) return null;
    const total = pos.cumSolReceived + finalLegSol;
    return this.finishClose(pos, reason, total);
  }

  /**
   * Flush all open rows to SQLite (shutdown). Safe cold path.
   */
  flushPersistenceSync(): void {
    if (!persistEnabled()) return;
    try {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      const store = getFeatureStore();
      for (const p of this.open.values()) {
        store.upsertOpenCurvePosition(p.mint, this.serializeOpen(p));
      }
    } catch {
      /* cold path */
    }
  }

  /**
   * Reload open positions after crash. Returns count restored. Does not emit positionOpened.
   */
  restoreFromFeatureStore(): number {
    if (!persistEnabled()) return 0;
    let n = 0;
    try {
      const store = getFeatureStore();
      const rows = store.loadOpenCurvePositions();
      const t0 = performance.now();
      for (const row of rows) {
        const pos = this.deserializeOpen(row.payload_json);
        if (!pos || pos.mint !== row.mint) continue;
        if (this.open.has(pos.mint)) continue;
        this.open.set(pos.mint, pos);
        this.recomputePnl(pos);
        n++;
      }
      if (n > 0) {
        console.log(
          `📂 [PositionManager] Restored ${n} open position(s) from SQLite | ⏱️${(performance.now() - t0).toFixed(2)}ms`,
        );
      }
    } catch {
      /* cold path */
    }
    return n;
  }

  private schedulePersistOpenRows(): void {
    if (!persistEnabled()) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        const store = getFeatureStore();
        for (const p of this.open.values()) {
          store.upsertOpenCurvePosition(p.mint, this.serializeOpen(p));
        }
      } catch {
        /* cold path */
      }
    }, PERSIST_DEBOUNCE_MS);
  }

  private serializeOpen(p: CurvePosition): string {
    const row: StoredCurvePositionV1 = {
      v: STORED_VERSION,
      id: p.id,
      mint: p.mint,
      entryTimestamp: p.entryTimestamp,
      originalEntrySol: p.originalEntrySol,
      cumSolReceived: p.cumSolReceived,
      initialTokenAmount: p.initialTokenAmount.toString(),
      remainingTokens: p.remainingTokens.toString(),
      entryProgress: p.entryProgress,
      entryPriceSOL: p.entryPriceSOL,
      entryMarketCapSOL: p.entryMarketCapSOL,
      entryPGrad: p.entryPGrad,
      entryBreakeven: p.entryBreakeven,
      currentPriceSOL: p.currentPriceSOL,
      currentProgress: p.currentProgress,
      currentRealSolSOL: p.currentRealSolSOL,
      currentMarketCapSOL: p.currentMarketCapSOL,
      lastUpdated: p.lastUpdated,
      peakPriceSOL: p.peakPriceSOL,
      persistedStatus: p.status === 'CLOSING' ? 'CLOSING' : 'OPEN',
    };
    return JSON.stringify(row);
  }

  private deserializeOpen(json: string): CurvePosition | null {
    try {
      const row = JSON.parse(json) as StoredCurvePositionV1;
      if ((row.v !== 1 && row.v !== STORED_VERSION) || typeof row.mint !== 'string') {
        return null;
      }
      const pos: CurvePosition = {
        id: row.id,
        mint: row.mint,
        entryTimestamp: row.entryTimestamp,
        originalEntrySol: row.originalEntrySol,
        cumSolReceived: row.cumSolReceived,
        initialTokenAmount: BigInt(row.initialTokenAmount),
        remainingTokens: BigInt(row.remainingTokens),
        entryProgress: row.entryProgress,
        entryPriceSOL: row.entryPriceSOL,
        entryMarketCapSOL: row.entryMarketCapSOL,
        entryPGrad: row.entryPGrad,
        entryBreakeven: row.entryBreakeven,
        currentPriceSOL: row.currentPriceSOL,
        currentProgress: row.currentProgress,
        currentRealSolSOL: row.currentRealSolSOL,
        currentMarketCapSOL: row.currentMarketCapSOL,
        lastUpdated: row.lastUpdated,
        unrealizedPnlSOL: 0,
        unrealizedPnlPct: 0,
        peakPriceSOL: row.peakPriceSOL,
        peakPnlPct: 0,
        maxDrawdownFromPeakPct: 0,
        status: 'OPEN',
        exitReason: null,
        exitTimestamp: null,
        exitSolReceived: null,
        realizedPnlSOL: null,
        realizedPnlPct: null,
        holdDurationS: null,
      };
      normalizeLegacySpotPrices(pos);
      return pos;
    } catch {
      return null;
    }
  }

  private finishClose(pos: CurvePosition, reason: string, totalSolReceived: number): CurvePosition {
    const mint = pos.mint;
    try {
      if (persistEnabled()) {
        getFeatureStore().deleteOpenCurvePosition(mint);
      }
    } catch {
      /* cold path */
    }
    pos.status = 'CLOSED';
    pos.exitReason = reason;
    pos.exitTimestamp = Date.now();
    pos.exitSolReceived = totalSolReceived;
    pos.realizedPnlSOL = totalSolReceived - pos.originalEntrySol;
    pos.realizedPnlPct =
      pos.originalEntrySol > 1e-12 ? pos.realizedPnlSOL / pos.originalEntrySol : 0;
    pos.holdDurationS = (pos.exitTimestamp - pos.entryTimestamp) / 1000;

    this.open.delete(mint);
    this.closed.push(pos);
    if (this.closed.length > MAX_CLOSED) {
      this.closed.splice(0, this.closed.length - MAX_CLOSED);
    }

    console.log(
      `📊 [PositionManager] CLOSED ${mint.slice(0, 8)}… | ${reason} | PnL=${(pos.realizedPnlPct * 100).toFixed(2)}% | ${pos.holdDurationS.toFixed(0)}s`,
    );
    this.emit('positionClosed', pos);
    return pos;
  }

  getOpenPositions(): CurvePosition[] {
    return Array.from(this.open.values());
  }

  getPosition(mint: string): CurvePosition | null {
    return this.open.get(mint) ?? null;
  }

  hasOpenPosition(mint: string): boolean {
    const p = this.open.get(mint);
    return p !== undefined && (p.status === 'OPEN' || p.status === 'CLOSING');
  }

  getOpenCount(): number {
    return this.open.size;
  }

  getClosedPositions(): CurvePosition[] {
    return [...this.closed];
  }

  getPortfolioSummary(): PortfolioSummary {
    let totalInvested = 0;
    let totalUnrealizedPnl = 0;
    for (const p of this.open.values()) {
      totalInvested += this.costBasisRemaining(p);
      totalUnrealizedPnl += p.unrealizedPnlSOL;
    }
    const totalUnrealizedPnlPct = totalInvested > 1e-12 ? totalUnrealizedPnl / totalInvested : 0;

    let totalRealizedPnl = 0;
    let wins = 0;
    let holdSum = 0;
    let pnlSum = 0;
    let best: CurvePosition | null = null;
    let worst: CurvePosition | null = null;

    const n = this.closed.length;
    for (const c of this.closed) {
      const r = c.realizedPnlSOL ?? 0;
      totalRealizedPnl += r;
      if (r > 0) wins++;
      holdSum += c.holdDurationS ?? 0;
      pnlSum += c.realizedPnlPct ?? 0;
      if (!best || (c.realizedPnlPct ?? 0) > (best.realizedPnlPct ?? -Infinity)) best = c;
      if (!worst || (c.realizedPnlPct ?? 0) < (worst.realizedPnlPct ?? Infinity)) worst = c;
    }

    return {
      openCount: this.open.size,
      totalInvested,
      totalUnrealizedPnl,
      totalUnrealizedPnlPct,
      totalRealizedPnl,
      winRate: n > 0 ? wins / n : 0,
      avgHoldDurationS: n > 0 ? holdSum / n : 0,
      avgPnlPct: n > 0 ? pnlSum / n : 0,
      bestTrade: best,
      worstTrade: worst,
    };
  }

  /** Pro-rata SOL still tied to remaining tokens. */
  private costBasisRemaining(p: CurvePosition): number {
    const init = numTokens(p.initialTokenAmount);
    const rem = numTokens(p.remainingTokens);
    if (init <= 0) return p.originalEntrySol;
    return p.originalEntrySol * (rem / init);
  }

  private recomputePnl(p: CurvePosition): void {
    normalizeLegacySpotPrices(p);
    const rem = numTokens(p.remainingTokens);
    const cur = p.currentPriceSOL;
    const marketValue = rem * cur;
    const costRem = this.costBasisRemaining(p);
    p.unrealizedPnlSOL = marketValue - costRem;
    p.unrealizedPnlPct = costRem > 1e-12 ? p.unrealizedPnlSOL / costRem : 0;

    if (cur > p.peakPriceSOL) {
      p.peakPriceSOL = cur;
    }
    p.peakPnlPct =
      p.entryPriceSOL > 1e-18 ? (p.peakPriceSOL - p.entryPriceSOL) / p.entryPriceSOL : 0;

    p.maxDrawdownFromPeakPct =
      p.peakPriceSOL > 1e-18 ? (p.peakPriceSOL - cur) / p.peakPriceSOL : 0;
  }
}
