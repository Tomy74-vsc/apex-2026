import type { CurveTradeEvent } from '../../types/bonding-curve.js';

const WINDOW_5M_MS = 5 * 60_000;
const WINDOW_1M_MS = 60_000;

function velocityFallbackSynthetic(): boolean {
  return (process.env.VELOCITY_FALLBACK_SYNTHETIC ?? '').trim() === '1';
}

export interface VelocitySignal {
  solPerMinute_5m: number;
  solPerMinute_1m: number;
  avgTradeSize_SOL: number;
  tradesToReachCurrentLevel: number;
  velocityAcceleration: number;
  velocityRatio: number;
  peakVelocity_5m: number;
  /** Même fenêtres mais tous les achats (incl. flux réserve) — colonnes ML comparaison A/B. */
  solPerMinute1mMixed: number;
  solPerMinute5mMixed: number;
  avgTradeSizeSOLMixed: number;
}

/**
 * Signal #1 du papier arXiv (Marino et al.) — le plus predictif.
 * Calcule la vitesse d'accumulation de SOL dans la bonding curve
 * a partir de l'historique des trades.
 */
export class VelocityAnalyzer {
  private peakVelocities: Map<string, number> = new Map();
  private prevVelocities: Map<string, { v: number; t: number }> = new Map();

  /** Fenêtres 1m/5m + taille moyenne — sans mise à jour des pics (signal mixte ML). */
  private computeRates(buys: CurveTradeEvent[], now: number): {
    solPerMinute_5m: number;
    solPerMinute_1m: number;
    avgTradeSize_SOL: number;
    count: number;
  } {
    if (buys.length === 0) {
      return { solPerMinute_5m: 0, solPerMinute_1m: 0, avgTradeSize_SOL: 0, count: 0 };
    }
    const buys5m = buys.filter((t) => now - t.timestamp < WINDOW_5M_MS);
    const buys1m = buys.filter((t) => now - t.timestamp < WINDOW_1M_MS);
    const solSum5m = buys5m.reduce((s, t) => s + t.solAmount, 0);
    const solSum1m = buys1m.reduce((s, t) => s + t.solAmount, 0);
    const elapsed5m = buys5m.length > 0
      ? Math.max(1, (now - Math.min(...buys5m.map((t) => t.timestamp))) / 60_000)
      : 5;
    const elapsed1m = buys1m.length > 0
      ? Math.max(1 / 60, (now - Math.min(...buys1m.map((t) => t.timestamp))) / 60_000)
      : 1;
    const totalBuySol = buys.reduce((s, t) => s + t.solAmount, 0);
    return {
      solPerMinute_5m: solSum5m / elapsed5m,
      solPerMinute_1m: solSum1m / elapsed1m,
      avgTradeSize_SOL: totalBuySol / buys.length,
      count: buys.length,
    };
  }

  analyze(mint: string, trades: CurveTradeEvent[]): VelocitySignal {
    const now = Date.now();
    const walletBuys = trades.filter((t) => t.isBuy && !t.synthetic);
    const mixedBuys = trades.filter((t) => t.isBuy);
    const mixed = this.computeRates(mixedBuys, now);

    let primaryBuys = walletBuys;
    if (walletBuys.length === 0 && velocityFallbackSynthetic() && mixedBuys.length > 0) {
      primaryBuys = mixedBuys;
    }

    const rates = this.computeRates(primaryBuys, now);
    if (rates.count === 0) {
      return {
        ...this.emptySignal(),
        solPerMinute1mMixed: mixed.solPerMinute_1m,
        solPerMinute5mMixed: mixed.solPerMinute_5m,
        avgTradeSizeSOLMixed: mixed.avgTradeSize_SOL,
      };
    }

    const solPerMinute_5m = rates.solPerMinute_5m;
    const solPerMinute_1m = rates.solPerMinute_1m;
    const avgTradeSize_SOL = rates.avgTradeSize_SOL;

    const prevPeak = this.peakVelocities.get(mint) ?? 0;
    const newPeak = Math.max(prevPeak, solPerMinute_5m);
    this.peakVelocities.set(mint, newPeak);

    const velocityRatio = newPeak > 0 ? solPerMinute_5m / newPeak : 0;

    let velocityAcceleration = 0;
    const prev = this.prevVelocities.get(mint);
    if (prev && now - prev.t > 0) {
      const dtMin = (now - prev.t) / 60_000;
      if (dtMin > 0) {
        velocityAcceleration = (solPerMinute_5m - prev.v) / dtMin;
      }
    }
    this.prevVelocities.set(mint, { v: solPerMinute_5m, t: now });

    return {
      solPerMinute_5m,
      solPerMinute_1m,
      avgTradeSize_SOL,
      tradesToReachCurrentLevel: rates.count,
      velocityAcceleration,
      velocityRatio,
      peakVelocity_5m: newPeak,
      solPerMinute1mMixed: mixed.solPerMinute_1m,
      solPerMinute5mMixed: mixed.solPerMinute_5m,
      avgTradeSizeSOLMixed: mixed.avgTradeSize_SOL,
    };
  }

  /** Purge state for a graduated/evicted mint. */
  clear(mint: string): void {
    this.peakVelocities.delete(mint);
    this.prevVelocities.delete(mint);
  }

  private emptySignal(): VelocitySignal {
    return {
      solPerMinute_5m: 0,
      solPerMinute_1m: 0,
      avgTradeSize_SOL: 0,
      tradesToReachCurrentLevel: 0,
      velocityAcceleration: 0,
      velocityRatio: 0,
      peakVelocity_5m: 0,
      solPerMinute1mMixed: 0,
      solPerMinute5mMixed: 0,
      avgTradeSizeSOLMixed: 0,
    };
  }
}
