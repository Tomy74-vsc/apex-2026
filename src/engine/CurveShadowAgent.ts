/**
 * CurveShadowAgent — shadow policy parallèle au flux GraduationPredictor + Kelly (decideCurve).
 * Ne trade jamais ; compare ENTER_CURVE vs SKIP pour offline / future RL (P5 shadow mode).
 */

import { EventEmitter } from 'events';
import type { CurveDecision } from './AIBrain.js';

export interface CurveShadowDecision {
  mint: string;
  shadowAction: 'ENTER_CURVE' | 'SKIP';
  liveAction: CurveDecision['action'];
  agreed: boolean;
  pGrad: number;
  breakeven: number;
  /** Heuristique shadow : raison courte si SKIP */
  shadowReason: string;
  timestamp: number;
}

const maxDecisions = 50_000;

function envBool(key: string, def: false): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return v === '1' || v.toLowerCase() === 'true';
}

export class CurveShadowAgent extends EventEmitter {
  private decisions: CurveShadowDecision[] = [];
  private loggedMints = new Set<string>();
  private enabled = true;

  private stats = {
    totalEvaluations: 0,
    agreements: 0,
    shadowEnters: 0,
    liveEnters: 0,
  };

  constructor() {
    super();
    console.log('👻 [CurveShadowAgent] Initialized (curve shadow — no execution)');
  }

  /**
   * Évalue une décision live curve. Appelé après decideCurve() — même features via live.prediction.
   * Politique placeholder : plus agressive sur pGrad vs breakeven, pénalités bot/creator légères.
   */
  evaluateCurve(mint: string, live: CurveDecision): CurveShadowDecision {
    if (!this.enabled) {
      const shadowAction: 'ENTER_CURVE' | 'SKIP' = 'SKIP';
      const agreed = shadowAction === live.action || (live.action !== 'ENTER_CURVE' && shadowAction === 'SKIP');
      return {
        mint,
        shadowAction,
        liveAction: live.action,
        agreed,
        pGrad: live.pGrad,
        breakeven: live.breakeven,
        shadowReason: 'disabled',
        timestamp: Date.now(),
      };
    }

    const t0 = performance.now();
    this.stats.totalEvaluations++;
    if (live.action === 'ENTER_CURVE') this.stats.liveEnters++;

    const { action: shadowAction, reason: shadowReason } = this.shadowCurvePolicy(live);
    const agreed =
      (shadowAction === 'ENTER_CURVE' && live.action === 'ENTER_CURVE') ||
      (shadowAction === 'SKIP' && live.action !== 'ENTER_CURVE');

    if (agreed) this.stats.agreements++;
    if (shadowAction === 'ENTER_CURVE') this.stats.shadowEnters++;

    const decision: CurveShadowDecision = {
      mint,
      shadowAction,
      liveAction: live.action,
      agreed,
      pGrad: live.pGrad,
      breakeven: live.breakeven,
      shadowReason,
      timestamp: Date.now(),
    };

    this.decisions.push(decision);
    if (this.decisions.length > maxDecisions) this.decisions.shift();

    const verbose = envBool('CURVE_SHADOW_VERBOSE', false);
    const isFirstMint = !this.loggedMints.has(mint);
    if (isFirstMint) this.loggedMints.add(mint);

    if (!agreed || verbose || (isFirstMint && shadowAction === 'ENTER_CURVE')) {
      const emoji = agreed ? '🤝' : '⚔️';
      const ms = performance.now() - t0;
      console.log(
        `${emoji} [CurveShadow] ${mint.slice(0, 8)} | shadow=${shadowAction} live=${live.action} | ` +
          `pGrad=${(live.pGrad * 100).toFixed(1)}% be=${(live.breakeven * 100).toFixed(1)}% | ` +
          `agree=${this.getAgreementRate().toFixed(1)}% | ${ms.toFixed(2)}ms`,
      );
    }

    this.emit('curveShadowDecision', decision);
    return decision;
  }

  /**
   * Placeholder RL — remplaçable par ONNX / policy PPO sur vecteur courbe.
   * Plus agressif que live : marge pGrad > breakeven réduite (0.92 vs gate live ~1.2×).
   */
  private shadowCurvePolicy(live: CurveDecision): {
    action: 'ENTER_CURVE' | 'SKIP';
    reason: string;
  } {
    const pr = live.prediction;
    if (pr.vetoReason) {
      return { action: 'SKIP', reason: `veto:${pr.vetoReason.slice(0, 48)}` };
    }

    const margin = parseFloat(process.env.CURVE_SHADOW_BREAKEVEN_MULT ?? '0.92');
    const mult = Number.isFinite(margin) ? margin : 0.92;
    const threshold = live.breakeven * mult;
    if (live.pGrad <= threshold) {
      return { action: 'SKIP', reason: 'pGrad_vs_be' };
    }

    if (pr.botSignal.botTransactionRatio > 0.58) {
      return { action: 'SKIP', reason: 'bot_ratio' };
    }
    if (pr.walletScore.creatorIsSelling) {
      return { action: 'SKIP', reason: 'creator_sell' };
    }
    if (pr.velocity.velocityRatio < 0.22) {
      return { action: 'SKIP', reason: 'velocity_ratio' };
    }

    return { action: 'ENTER_CURVE', reason: 'shadow_enter' };
  }

  getAgreementRate(): number {
    if (this.stats.totalEvaluations === 0) return 100;
    return (this.stats.agreements / this.stats.totalEvaluations) * 100;
  }

  getStats() {
    return {
      totalEvaluations: this.stats.totalEvaluations,
      agreements: this.stats.agreements,
      agreementRate: this.getAgreementRate(),
      shadowEnters: this.stats.shadowEnters,
      liveEnters: this.stats.liveEnters,
      recentDecisions: this.decisions.slice(-20),
    };
  }
}

let _curveShadow: CurveShadowAgent | null = null;

export function getCurveShadowAgent(): CurveShadowAgent {
  if (!_curveShadow) _curveShadow = new CurveShadowAgent();
  return _curveShadow;
}
