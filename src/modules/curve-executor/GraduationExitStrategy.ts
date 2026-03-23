import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import type { CurveExecutor } from './CurveExecutor.js';
import type { CurvePosition } from '../position/PositionManager.js';
import { getPositionManager } from '../position/PositionManager.js';
import { calcSellOutput } from '../../math/curve-math.js';
import { decodeBondingCurve, deriveBondingCurvePDA } from '../../types/bonding-curve.js';
import { getCurveVelocityAnalyzer } from '../position/curveVelocitySingleton.js';

const SLIPPAGE_FRAC = 0.02;

export interface GraduationExitResult {
  mint: string;
  tranche1Executed: boolean;
  tranche1SolReceived: number;
  tranche2Scheduled: boolean;
  tranche2SolReceived: number | null;
  tranche3MonitorActive: boolean;
  totalSolRecovered: number;
  totalPnlSOL: number;
  totalPnlPct: number;
}

function pctOf(total: bigint, pct: bigint): bigint {
  if (total <= 0n) return 0n;
  return (total * pct) / 100n;
}

function envPct(key: string, fallback: number): bigint {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return BigInt(fallback);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return BigInt(fallback);
  return BigInt(n);
}

function envDelayMs(primary: string, aliases: string[], fallback: number): number {
  for (const k of [primary, ...aliases]) {
    const v = process.env[k];
    if (v !== undefined && v !== '') {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return fallback;
}

function estimateLegSol(vSol: bigint, vToken: bigint, tokenAmt: bigint, reportedSol: number): number {
  if (vSol > 0n && vToken > 0n && tokenAmt > 0n) {
    const lamports = calcSellOutput(vSol, vToken, tokenAmt);
    const ideal = Number(lamports) / Number(LAMPORTS_PER_SOL);
    return ideal * (1 - SLIPPAGE_FRAC);
  }
  return reportedSol * (1 - SLIPPAGE_FRAC);
}

/**
 * Graduation: T1 40% (awaited), T2 30% of initial (delayed), T3 remainder (delayed).
 * Uses markClosing to dedupe concurrent handlers. Timers use .unref() where available.
 */
export class GraduationExitStrategy {
  async executeGraduationExit(
    position: CurvePosition,
    executor: CurveExecutor,
    vSol: bigint,
    vToken: bigint,
    slippageBps: number,
  ): Promise<GraduationExitResult> {
    const mint = position.mint;
    const pm = getPositionManager();

    if (!pm.markClosing(mint)) {
      console.log(`🎓 [GradExit] skip ${mint.slice(0, 8)}… — already closing/closed`);
      return {
        mint,
        tranche1Executed: false,
        tranche1SolReceived: 0,
        tranche2Scheduled: false,
        tranche2SolReceived: null,
        tranche3MonitorActive: false,
        totalSolRecovered: 0,
        totalPnlSOL: 0,
        totalPnlPct: 0,
      };
    }

    const t1Pct = envPct('GRAD_T1_PCT', 40);
    const t2Pct = envPct('GRAD_T2_PCT', 35);
    const t2Delay = envDelayMs('GRAD_T2_DELAY_MS', ['GRAD_EXIT_T2_MS'], 60_000);
    const t3Delay = envDelayMs('GRAD_T3_DELAY_MS', ['GRAD_EXIT_T3_MS'], 30_000);

    const initRem = position.remainingTokens;
    const t1Tokens = pctOf(initRem, t1Pct);
    let t1Sol = 0;
    let t1Ok = false;

    if (t1Tokens > 0n) {
      const r1 = await executor.sell(mint, t1Tokens, slippageBps, vSol, vToken);
      if (r1.success) {
        t1Sol = estimateLegSol(vSol, vToken, t1Tokens, r1.solAmount);
        pm.applyPartialExit(mint, t1Tokens, t1Sol);
        t1Ok = true;
        console.log(`🎓 [GradExit] T1 ${mint.slice(0, 8)}… | +${t1Sol.toFixed(4)} SOL (${t1Pct}%)`);
      } else {
        pm.abortClosing(mint);
        console.log(`🎓 [GradExit] T1 failed ${mint.slice(0, 8)}… — status OPEN restored`);
      }
    }

    const posAfter = pm.getPosition(mint);
    let tranche2Scheduled = false;
    if (posAfter && posAfter.remainingTokens > 0n) {
      tranche2Scheduled = true;
      const t = setTimeout(() => {
        void this.runTranche2(mint, executor, slippageBps, t3Delay);
      }, t2Delay);
      (t as { unref?: () => void }).unref?.();
    } else {
      void this.finalizeIfNeeded(mint);
    }

    const cum = pm.getPosition(mint)?.cumSolReceived ?? t1Sol;
    const pnl = cum - position.originalEntrySol;

    return {
      mint,
      tranche1Executed: t1Ok,
      tranche1SolReceived: t1Sol,
      tranche2Scheduled,
      tranche2SolReceived: null,
      tranche3MonitorActive: tranche2Scheduled,
      totalSolRecovered: cum,
      totalPnlSOL: pnl,
      totalPnlPct: position.originalEntrySol > 1e-12 ? pnl / position.originalEntrySol : 0,
    };
  }

  private async runTranche2(mint: string, executor: CurveExecutor, slippageBps: number, t3Delay: number): Promise<void> {
    const pm = getPositionManager();
    const pos = pm.getPosition(mint);
    if (!pos || pos.remainingTokens <= 0n) {
      void this.finalizeIfNeeded(mint);
      return;
    }

    const t2Pct = envPct('GRAD_T2_PCT', 35);
    const want = pctOf(pos.initialTokenAmount, t2Pct);
    const toSell = want > pos.remainingTokens ? pos.remainingTokens : want;
    if (toSell <= 0n) {
      void this.finalizeIfNeeded(mint);
      return;
    }

    const { vSol, vToken } = await this.fetchReserves(mint);
    const r2 = await executor.sell(mint, toSell, slippageBps, vSol, vToken);
    if (r2.success) {
      const sol = estimateLegSol(vSol, vToken, toSell, r2.solAmount);
      pm.applyPartialExit(mint, toSell, sol);
      console.log(`🎓 [GradExit] T2 ${mint.slice(0, 8)}… | +${sol.toFixed(4)} SOL (${t2Pct}% of initial)`);
    }

    const t = setTimeout(() => {
      void this.runTranche3(mint, executor, slippageBps);
    }, t3Delay);
    (t as { unref?: () => void }).unref?.();
  }

  private async runTranche3(mint: string, executor: CurveExecutor, slippageBps: number): Promise<void> {
    const pm = getPositionManager();
    const pos = pm.getPosition(mint);
    if (!pos || pos.remainingTokens <= 0n) {
      void this.finalizeIfNeeded(mint);
      return;
    }

    const { vSol, vToken } = await this.fetchReserves(mint);
    const toSell = pos.remainingTokens;
    const r3 = await executor.sell(mint, toSell, slippageBps, vSol, vToken);
    if (r3.success) {
      const sol = estimateLegSol(vSol, vToken, toSell, r3.solAmount);
      pm.closeWithFinalLeg(mint, 'graduation', sol);
      getCurveVelocityAnalyzer().clear(mint);
      console.log(`🎓 [GradExit] T3 ${mint.slice(0, 8)}… | +${sol.toFixed(4)} SOL (remainder)`);
    } else {
      void this.finalizeIfNeeded(mint);
    }
  }

  private finalizeIfNeeded(mint: string): void {
    const pm = getPositionManager();
    const p = pm.getPosition(mint);
    if (!p) return;
    if (p.remainingTokens === 0n) {
      pm.closePosition(mint, 'graduation_flat', p.cumSolReceived);
      getCurveVelocityAnalyzer().clear(mint);
    }
  }

  private async fetchReserves(mint: string): Promise<{ vSol: bigint; vToken: bigint }> {
    const rpc = process.env.HELIUS_RPC_URL ?? process.env.RPC_URL;
    if (!rpc) return { vSol: 0n, vToken: 0n };
    try {
      const conn = new Connection(rpc, 'confirmed');
      const [pda] = deriveBondingCurvePDA(new PublicKey(mint));
      const acc = await conn.getAccountInfo(pda, 'confirmed');
      if (!acc?.data) return { vSol: 0n, vToken: 0n };
      const st = decodeBondingCurve(Buffer.from(acc.data));
      return { vSol: st.virtualSolReserves, vToken: st.virtualTokenReserves };
    } catch {
      return { vSol: 0n, vToken: 0n };
    }
  }
}
