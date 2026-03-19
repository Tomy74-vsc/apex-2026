import type { CurveTradeEvent } from '../../types/bonding-curve.js';

const FRESH_WALLET_AGE_MS = 24 * 60 * 60_000;
const UNIFORM_TOLERANCE_SOL = 0.01;

export interface BotSignal {
  freshWalletRatio: number;
  uniformTradeSizeRatio: number;
  sameBlockBuyCount: number;
  botTransactionRatio: number;
  isVeto: boolean;
}

/**
 * Signal #3 du papier arXiv — negatif: plus de bots = moins de graduation.
 *
 * Heuristiques:
 * - freshWalletRatio: wallets < 24h (need external data; estimated from trade patterns)
 * - uniformTradeSizeRatio: trades with identical amounts (bot signature)
 * - sameBlockBuyCount: multiple buys in the same slot
 * - Composite score 0-1 → veto if > 0.7
 */
export class BotDetector {
  private knownWalletFirstSeen: Map<string, number> = new Map();

  analyze(trades: CurveTradeEvent[]): BotSignal {
    const buys = trades.filter((t) => t.isBuy);
    if (buys.length < 3) {
      return { freshWalletRatio: 0, uniformTradeSizeRatio: 0, sameBlockBuyCount: 0, botTransactionRatio: 0, isVeto: false };
    }

    // 1. Fresh wallet ratio
    const now = Date.now();
    let freshCount = 0;
    const uniqueTraders = new Set<string>();

    for (const buy of buys) {
      uniqueTraders.add(buy.trader);
      if (!this.knownWalletFirstSeen.has(buy.trader)) {
        this.knownWalletFirstSeen.set(buy.trader, buy.timestamp);
      }
      const firstSeen = this.knownWalletFirstSeen.get(buy.trader)!;
      if (now - firstSeen < FRESH_WALLET_AGE_MS) {
        freshCount++;
      }
    }
    const freshWalletRatio = uniqueTraders.size > 0
      ? freshCount / uniqueTraders.size
      : 0;

    // 2. Uniform trade size ratio
    const sizeMap = new Map<string, number>();
    for (const buy of buys) {
      const key = buy.solAmount.toFixed(2);
      sizeMap.set(key, (sizeMap.get(key) ?? 0) + 1);
    }
    let uniformCount = 0;
    for (const [, count] of sizeMap) {
      if (count >= 3) {
        uniformCount += count;
      }
    }
    const uniformTradeSizeRatio = buys.length > 0 ? uniformCount / buys.length : 0;

    // 3. Same-block buy count
    const slotCounts = new Map<number, number>();
    for (const buy of buys) {
      slotCounts.set(buy.slot, (slotCounts.get(buy.slot) ?? 0) + 1);
    }
    let sameBlockBuyCount = 0;
    for (const [, count] of slotCounts) {
      if (count >= 2) sameBlockBuyCount += count;
    }

    // 4. Composite score (weighted heuristic)
    const botTransactionRatio = Math.min(1,
      freshWalletRatio * 0.3 +
      uniformTradeSizeRatio * 0.4 +
      (sameBlockBuyCount / Math.max(1, buys.length)) * 0.3,
    );

    return {
      freshWalletRatio,
      uniformTradeSizeRatio,
      sameBlockBuyCount,
      botTransactionRatio,
      isVeto: botTransactionRatio > 0.7,
    };
  }

  /** Purge state for graduated/evicted mints. */
  pruneOldWallets(): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
    for (const [addr, ts] of this.knownWalletFirstSeen) {
      if (ts < cutoff) this.knownWalletFirstSeen.delete(addr);
    }
  }
}
