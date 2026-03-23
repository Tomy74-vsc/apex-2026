import type { CurvePosition } from './PositionManager.js';
import type { TrackedCurve } from '../../types/bonding-curve.js';
import type { VelocitySignal } from '../graduation-predictor/VelocityAnalyzer.js';

export type ExitReason =
  | 'graduation'
  | 'stop_loss'
  | 'progress_regression'
  | 'trailing_stop'
  | 'stall'
  | 'time_stop'
  | 'take_profit'
  | 'velocity_collapse';

export type ExitAction = 'SELL_100PCT' | 'SELL_50PCT' | 'GRADUATION_EXIT_3TRANCHE';

export type ExitUrgency = 'CRITICAL' | 'HIGH' | 'MEDIUM';

export interface ExitSignal {
  mint: string;
  reason: ExitReason;
  action: ExitAction;
  urgency: ExitUrgency;
  detail: string;
  positionPnlPct: number;
}

/** Optional live pGrad (throttled refresh in app) to relax time-stop per APEX §8. */
export interface ExitEvaluateOptions {
  livePGrad?: number;
}

function envFloat(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

function envInt(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

let singleton: ExitEngine | null = null;

export function getExitEngine(): ExitEngine {
  if (!singleton) {
    singleton = new ExitEngine();
  }
  return singleton;
}

/**
 * Exit rule cascade — single pass, no allocations except returned ExitSignal.
 * Defaults alignés APEX_QUANT_STRATEGY §0.2 + §8 — profil Rotation (300s, stall 0.05 SOL/min × 90s).
 * Ordre : graduation/SL/regression → hard time → (cooldown) → trailing reliquat post-TP50 OU trailing pré-TP
 *   → velocity collapse → stall → soft time → TP partiel.
 */
export class ExitEngine {
  private readonly stopLossPct: number;
  private readonly trailingStopPct: number;
  private readonly takeProfitPct: number;
  private readonly maxHoldMs: number;
  private readonly stallSolFlowMin: number;
  private readonly stallDurationMs: number;
  private readonly velocityCollapseRatio: number;
  private readonly minCooldownMs: number;
  private readonly timeStopMinPGrad: number;
  private readonly hardMaxHoldMs: number;
  /** Trailing sur reliquat après TP 50 % (pic prix remainder vs spot). */
  private readonly trailingRemainderPct: number;
  private readonly lastEvalMs: Map<string, number> = new Map();
  private readonly stallLowSince: Map<string, number> = new Map();

  constructor() {
    this.stopLossPct = envFloat('STOP_LOSS_PCT', 0.15);
    this.trailingStopPct = envFloat('TRAILING_STOP_PCT', 0.2);
    this.takeProfitPct = envFloat('TAKE_PROFIT_PCT', 0.5);
    if (process.env.MAX_HOLD_TIME_MINUTES !== undefined && process.env.MAX_HOLD_TIME_MINUTES !== '') {
      this.maxHoldMs = envInt('MAX_HOLD_TIME_MINUTES', 10) * 60_000;
    } else {
      this.maxHoldMs = envInt('TIME_STOP_SECONDS', 300) * 1000;
    }
    this.hardMaxHoldMs = envInt('HARD_MAX_HOLD_SECONDS', 300) * 1000;
    this.stallSolFlowMin = envFloat('STALL_SOL_FLOW_MIN', 0.05);
    this.stallDurationMs = envInt('STALL_DURATION_SECONDS', 90) * 1000;
    this.velocityCollapseRatio = envFloat('VELOCITY_COLLAPSE_RATIO', 0.3);
    this.minCooldownMs = envInt('EXIT_EVAL_COOLDOWN_MS', 3_000);
    this.timeStopMinPGrad = envFloat('TIME_STOP_MIN_PGRAD', 0.5);
    this.trailingRemainderPct = envFloat('TRAILING_REMAINDER_PCT', 0.15);

    console.log(
      `🛡️ [ExitEngine] SL=${(this.stopLossPct * 100).toFixed(0)}% trail=${(this.trailingStopPct * 100).toFixed(0)}% ` +
        `remainderTrail=${(this.trailingRemainderPct * 100).toFixed(0)}% ` +
        `TP=${(this.takeProfitPct * 100).toFixed(0)}% softTime=${(this.maxHoldMs / 1000).toFixed(0)}s ` +
        `hardMax=${(this.hardMaxHoldMs / 1000).toFixed(0)}s (NO BYPASS) ` +
        `stallSOL<${this.stallSolFlowMin}/min ×${(this.stallDurationMs / 1000).toFixed(0)}s ` +
        `collapseRatio=${this.velocityCollapseRatio} timeStopSkipPGrad≥${this.timeStopMinPGrad} cooldown=${this.minCooldownMs}ms`,
    );
  }

  evaluate(
    position: CurvePosition,
    curve: TrackedCurve,
    velocity: VelocitySignal,
    opts?: ExitEvaluateOptions,
  ): ExitSignal | null {
    const mint = position.mint;
    const now = Date.now();
    const pnlPct = position.unrealizedPnlPct;

    if (curve.state.complete === true || curve.progress >= 0.99) {
      this.lastEvalMs.set(mint, now);
      this.stallLowSince.delete(mint);
      return this.sig(mint, 'graduation', 'GRADUATION_EXIT_3TRANCHE', 'CRITICAL', 'curve complete / terminal progress', pnlPct);
    }

    if (pnlPct < -this.stopLossPct) {
      this.lastEvalMs.set(mint, now);
      this.stallLowSince.delete(mint);
      return this.sig(mint, 'stop_loss', 'SELL_100PCT', 'CRITICAL', `pnl ${(pnlPct * 100).toFixed(2)}% < -${(this.stopLossPct * 100).toFixed(0)}%`, pnlPct);
    }

    if (position.currentProgress < position.entryProgress - 0.1) {
      this.lastEvalMs.set(mint, now);
      this.stallLowSince.delete(mint);
      return this.sig(
        mint,
        'progress_regression',
        'SELL_100PCT',
        'HIGH',
        `progress ${(position.entryProgress * 100).toFixed(0)}% → ${(position.currentProgress * 100).toFixed(0)}%`,
        pnlPct,
      );
    }

    if (now - position.entryTimestamp > this.hardMaxHoldMs) {
      this.lastEvalMs.set(mint, now);
      this.stallLowSince.delete(mint);
      return this.sig(
        mint,
        'time_stop',
        'SELL_100PCT',
        'CRITICAL',
        `HARD time stop: held > ${(this.hardMaxHoldMs / 1000).toFixed(0)}s (NO bypass)`,
        pnlPct,
      );
    }

    const last = this.lastEvalMs.get(mint) ?? 0;
    if (now - last < this.minCooldownMs) {
      return null;
    }
    this.lastEvalMs.set(mint, now);

    if (position.partialTakeProfitDone) {
      if (
        position.remainderPeakPriceSOL > 1e-18 &&
        position.maxDrawdownFromRemainderPeakPct > this.trailingRemainderPct
      ) {
        this.stallLowSince.delete(mint);
        return this.sig(
          mint,
          'trailing_stop',
          'SELL_100PCT',
          'HIGH',
          `remainder trail ${(position.maxDrawdownFromRemainderPeakPct * 100).toFixed(1)}% > ${(this.trailingRemainderPct * 100).toFixed(0)}% (post-TP50)`,
          pnlPct,
        );
      }
    } else if (position.peakPnlPct > 0.1 && position.maxDrawdownFromPeakPct > this.trailingStopPct) {
      this.stallLowSince.delete(mint);
      return this.sig(
        mint,
        'trailing_stop',
        'SELL_100PCT',
        'HIGH',
        `drawdown from peak ${(position.maxDrawdownFromPeakPct * 100).toFixed(1)}% > ${(this.trailingStopPct * 100).toFixed(0)}%`,
        pnlPct,
      );
    }

    if (
      velocity.velocityRatio < this.velocityCollapseRatio &&
      velocity.velocityAcceleration < -0.5 &&
      velocity.solPerMinute_1m < this.stallSolFlowMin
    ) {
      if (pnlPct > 0.05 || pnlPct < -0.05) {
        this.stallLowSince.delete(mint);
        return this.sig(mint, 'velocity_collapse', 'SELL_100PCT', pnlPct > 0 ? 'HIGH' : 'MEDIUM', 'velocity collapsed vs peak', pnlPct);
      }
    }

    if (velocity.solPerMinute_1m < this.stallSolFlowMin) {
      const t0 = this.stallLowSince.get(mint);
      if (t0 === undefined) {
        this.stallLowSince.set(mint, now);
      } else if (now - t0 >= this.stallDurationMs) {
        this.stallLowSince.delete(mint);
        return this.sig(
          mint,
          'stall',
          'SELL_100PCT',
          'MEDIUM',
          `sol/min ${velocity.solPerMinute_1m.toFixed(3)} < ${this.stallSolFlowMin} for ${(this.stallDurationMs / 1000).toFixed(0)}s+`,
          pnlPct,
        );
      }
    } else {
      this.stallLowSince.delete(mint);
    }

    if (now - position.entryTimestamp > this.maxHoldMs) {
      const live = opts?.livePGrad;
      if (live !== undefined && live >= this.timeStopMinPGrad) {
        /* APEX: hold while live estimate stays ≥ threshold */
      } else {
        this.stallLowSince.delete(mint);
        return this.sig(
          mint,
          'time_stop',
          'SELL_100PCT',
          'MEDIUM',
          `held > ${(this.maxHoldMs / 1000).toFixed(0)}s (livePGrad=${live?.toFixed(2) ?? 'n/a'})`,
          pnlPct,
        );
      }
    }

    if (pnlPct > this.takeProfitPct && velocity.velocityRatio < 0.5) {
      return this.sig(mint, 'take_profit', 'SELL_50PCT', 'MEDIUM', `tp ${(pnlPct * 100).toFixed(1)}% + weak momentum`, pnlPct);
    }

    return null;
  }

  clearCooldown(mint: string): void {
    this.lastEvalMs.delete(mint);
    this.stallLowSince.delete(mint);
  }

  private sig(
    mint: string,
    reason: ExitReason,
    action: ExitAction,
    urgency: ExitUrgency,
    detail: string,
    positionPnlPct: number,
  ): ExitSignal {
    console.log(
      `🚨 [ExitEngine] ${mint.slice(0, 8)}… → ${reason} | PnL=${(positionPnlPct * 100).toFixed(2)}% | ${detail}`,
    );
    return { mint, reason, action, urgency, detail, positionPnlPct };
  }
}
