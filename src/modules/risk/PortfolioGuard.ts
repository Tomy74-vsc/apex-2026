/**
 * Caps concurrent curve positions + paper bankroll exposure before ENTER_CURVE emission.
 * Optional daily loss halt (UTC day) vs bankroll snapshot at day start.
 */

import { getPositionManager } from '../position/PositionManager.js';

function envInt(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function envFloat(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

let singleton: PortfolioGuard | null = null;

export function getPortfolioGuard(): PortfolioGuard {
  if (!singleton) singleton = new PortfolioGuard();
  return singleton;
}

export class PortfolioGuard {
  private readonly DAILY_LOSS_HALT_PCT = envFloat('DAILY_LOSS_HALT_PCT', 0.15);
  private dailyStartBankroll = 0;
  private haltedUntil: number | null = null;

  /**
   * Snapshot bankroll début de journée (SOL). Réappeler au reset UTC (app.ts).
   * Lève un halt actif pour reprendre trading après pause.
   */
  initDailyTracking(currentBankroll: number): void {
    this.dailyStartBankroll = Math.max(1e-9, currentBankroll);
    this.haltedUntil = null;
    console.log(
      `🛡️ [PortfolioGuard] Daily tracking — bankroll=${currentBankroll.toFixed(4)} SOL halt_if_loss>${(this.DAILY_LOSS_HALT_PCT * 100).toFixed(0)}%`,
    );
  }

  /**
   * @param opts.currentBankrollSol — equity paper approx (bankroll + PnL réalisé + non réalisé). Sinon fallback env.
   */
  canEnterNewPosition(
    proposedSol: number,
    opts?: { currentBankrollSol?: number },
  ): { ok: boolean; reason?: string } {
    if (this.haltedUntil !== null && Date.now() < this.haltedUntil) {
      const remainMin = Math.ceil((this.haltedUntil - Date.now()) / 60_000);
      return { ok: false, reason: `daily_loss_halt (${remainMin}min restantes)` };
    }

    const currentBankroll =
      opts?.currentBankrollSol ??
      Math.max(1e-9, envFloat('PAPER_BANKROLL_SOL', 1));

    if (this.dailyStartBankroll > 0) {
      const dailyLossPct = (this.dailyStartBankroll - currentBankroll) / this.dailyStartBankroll;
      if (dailyLossPct > this.DAILY_LOSS_HALT_PCT) {
        this.haltedUntil = Date.now() + 60 * 60 * 1000;
        console.error(
          `🛑 [PortfolioGuard] DAILY LOSS HALT — perte=${(dailyLossPct * 100).toFixed(1)}% > ${(this.DAILY_LOSS_HALT_PCT * 100).toFixed(0)}% — pause 1h`,
        );
        return { ok: false, reason: 'daily_loss_halt_triggered' };
      }
    }

    const maxConc =
      envInt(
        'MAX_CONCURRENT_CURVE_POSITIONS',
        envInt('MAX_CONCURRENT_POSITIONS', 5),
      ) || 5;
    const pm = getPositionManager();
    const open = pm.getOpenCount();
    if (open >= maxConc) {
      return { ok: false, reason: `open ${open} >= max_concurrent ${maxConc}` };
    }

    const bankroll = Math.max(1e-9, envFloat('PAPER_BANKROLL_SOL', 1));
    const maxExpPct = envFloat('MAX_PORTFOLIO_EXPOSURE_PCT', 0.2);
    const summary = pm.getPortfolioSummary();
    const nextExposure = summary.totalInvested + Math.max(0, proposedSol);
    const cap = bankroll * maxExpPct;
    if (nextExposure > cap + 1e-9) {
      return {
        ok: false,
        reason: `exposure ${((nextExposure / bankroll) * 100).toFixed(1)}% > ${(maxExpPct * 100).toFixed(0)}% cap`,
      };
    }

    return { ok: true };
  }
}
