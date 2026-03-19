import type { CurveTradeEvent } from '../../types/bonding-curve.js';

export interface WalletScore {
  smartMoneyBuyerCount: number;
  smartMoneySOLTotal: number;
  creatorHistoricalGradRate: number;
  creatorTokenCount: number;
  creatorIsSelling: boolean;
  freshWalletRatio: number;
}

/**
 * Signal #2 du papier arXiv — modeste mais utile.
 *
 * Evalue la qualite des participants sur une bonding curve:
 * - Smart money presence (leverage SmartMoneyTracker wallet list)
 * - Creator history (serial launcher = mauvais signe)
 * - Creator selling during curve = RED FLAG absolu
 */
export class WalletScorer {
  private readonly smartMoneyAddresses: Set<string>;
  private readonly creatorHistory: Map<string, { total: number; graduated: number }> = new Map();

  constructor(smartMoneyAddresses?: Set<string>) {
    this.smartMoneyAddresses = smartMoneyAddresses ?? new Set();
  }

  /**
   * Import known smart money addresses from SmartMoneyTracker.
   */
  setSmartMoneyList(addresses: string[]): void {
    this.smartMoneyAddresses.clear();
    for (const addr of addresses) {
      this.smartMoneyAddresses.add(addr);
    }
  }

  /**
   * Record a creator's token outcome for historical rate tracking.
   */
  recordCreatorOutcome(creator: string, graduated: boolean): void {
    const hist = this.creatorHistory.get(creator) ?? { total: 0, graduated: 0 };
    hist.total++;
    if (graduated) hist.graduated++;
    this.creatorHistory.set(creator, hist);
  }

  analyze(
    trades: CurveTradeEvent[],
    creator: string,
  ): WalletScore {
    if (trades.length === 0) {
      return {
        smartMoneyBuyerCount: 0,
        smartMoneySOLTotal: 0,
        creatorHistoricalGradRate: 0,
        creatorTokenCount: 0,
        creatorIsSelling: false,
        freshWalletRatio: 0,
      };
    }

    // Smart money analysis
    const smBuyers = new Set<string>();
    let smSOL = 0;
    const allTraders = new Set<string>();

    for (const trade of trades) {
      allTraders.add(trade.trader);
      if (trade.isBuy && this.smartMoneyAddresses.has(trade.trader)) {
        smBuyers.add(trade.trader);
        smSOL += trade.solAmount;
      }
    }

    // Creator selling detection — RED FLAG
    const creatorIsSelling = trades.some(
      (t) => !t.isBuy && t.trader === creator,
    );

    // Creator historical graduation rate
    const hist = this.creatorHistory.get(creator);
    const creatorTokenCount = hist?.total ?? 0;
    const creatorHistoricalGradRate =
      creatorTokenCount > 0 ? (hist!.graduated / creatorTokenCount) : 0;

    // Fresh wallet ratio (approximation: wallets seen only in this token)
    const uniqueTraders = new Set(trades.map((t) => t.trader));
    const singleAppearance = [...uniqueTraders].filter(
      (addr) => trades.filter((t) => t.trader === addr).length === 1,
    );
    const freshWalletRatio = uniqueTraders.size > 0
      ? singleAppearance.length / uniqueTraders.size
      : 0;

    return {
      smartMoneyBuyerCount: smBuyers.size,
      smartMoneySOLTotal: smSOL,
      creatorHistoricalGradRate,
      creatorTokenCount,
      creatorIsSelling,
      freshWalletRatio,
    };
  }
}
