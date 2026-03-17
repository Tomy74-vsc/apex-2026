/**
 * SmartMoneyTracker — APEX-2026 Phase 2 (P2.2.2)
 *
 * Monitors high-conviction wallets in real-time via accountSubscribe.
 * Computes Smart Money signal S_SM(t) with exponential time-decay.
 *
 * Formula:
 *   S_SM(t) = Σ_{w ∈ tracked} ρ(w) × Σ_{k ∈ trades(w)} v_k × exp(-(t - t_k) / τ_sm)
 *
 * Guerrilla constraints:
 *   - Max 50-100 wallets monitored (RPC rate limits)
 *   - Batch queries for remaining wallets every 30s
 *   - Free tier compatible (accountSubscribe via WebSocket)
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';

export interface WalletProfile {
  address: string;
  trustScore: number;  // ρ(w): 0 to 1 — historical win rate
  label?: string;      // "whale", "dex_arb", "insider", etc.
  lastSeen: number;    // Unix ms
}

export interface SmartMoneyTrade {
  wallet: string;
  mint: string;
  direction: 'BUY' | 'SELL';
  amountSol: number;
  timestamp: number;
}

export interface SmartMoneySignal {
  mint: string;
  score: number;        // S_SM(t) — aggregated smart money score
  buyCount: number;
  sellCount: number;
  netFlow: number;      // SOL — positive = net buying
  topBuyers: string[];  // top 3 wallet addresses
  computedAt: number;
}

const TAU_SM_MS = 300_000; // τ_sm = 5 minutes decay
const MAX_WALLETS = 100;
const MAX_TRADES_PER_MINT = 200;
const BATCH_INTERVAL_MS = 30_000;

export class SmartMoneyTracker extends EventEmitter {
  private wallets: Map<string, WalletProfile> = new Map();
  private trades: Map<string, SmartMoneyTrade[]> = new Map(); // mint → trades
  private connection: Connection;
  private subscriptions: Map<string, number> = new Map(); // wallet → subscriptionId
  private batchInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  private stats = {
    tradesRecorded: 0,
    signalsEmitted: 0,
    walletsMonitored: 0,
  };

  constructor(rpcUrl?: string) {
    super();
    const url = rpcUrl || process.env.HELIUS_RPC_URL || process.env.RPC_URL || '';
    this.connection = new Connection(url, { commitment: 'confirmed' });
    console.log('💰 [SmartMoneyTracker] Initialized');
  }

  /**
   * Add wallets to monitor.
   * Wallets are sorted by trust score, only top MAX_WALLETS are subscribed.
   */
  addWallets(wallets: WalletProfile[]): void {
    for (const w of wallets) {
      this.wallets.set(w.address, w);
    }
    this.stats.walletsMonitored = this.wallets.size;
    console.log(`💰 [SmartMoneyTracker] ${this.wallets.size} wallets registered`);
  }

  /**
   * Record a trade observed from a smart money wallet.
   * Called by external monitoring (WebSocket accountSubscribe or batch query).
   */
  recordTrade(trade: SmartMoneyTrade): void {
    this.stats.tradesRecorded++;

    const { mint } = trade;
    if (!this.trades.has(mint)) {
      this.trades.set(mint, []);
    }

    const list = this.trades.get(mint)!;
    list.push(trade);

    // Evict old
    const cutoff = Date.now() - TAU_SM_MS * 3;
    while (list.length > 0 && list[0]!.timestamp < cutoff) {
      list.shift();
    }
    if (list.length > MAX_TRADES_PER_MINT) {
      list.splice(0, list.length - MAX_TRADES_PER_MINT);
    }

    // Emit signal update
    const signal = this.computeSignal(mint);
    if (signal) {
      this.stats.signalsEmitted++;
      this.emit('smartMoneySignal', signal);
    }
  }

  /**
   * Compute S_SM(t) for a given mint.
   */
  computeSignal(mint: string): SmartMoneySignal | null {
    const list = this.trades.get(mint);
    if (!list || list.length === 0) return null;

    const now = Date.now();
    let score = 0;
    let buyCount = 0;
    let sellCount = 0;
    let netFlow = 0;
    const buyerScores: Array<{ wallet: string; contribution: number }> = [];

    for (const trade of list) {
      const wallet = this.wallets.get(trade.wallet);
      const rho = wallet?.trustScore ?? 0.5;

      const dt = (now - trade.timestamp) / TAU_SM_MS;
      const decay = Math.exp(-dt);

      const sign = trade.direction === 'BUY' ? 1 : -1;
      const contribution = rho * trade.amountSol * sign * decay;
      score += contribution;

      if (trade.direction === 'BUY') {
        buyCount++;
        netFlow += trade.amountSol;
        buyerScores.push({ wallet: trade.wallet, contribution });
      } else {
        sellCount++;
        netFlow -= trade.amountSol;
      }
    }

    // Top 3 buyers by contribution
    buyerScores.sort((a, b) => b.contribution - a.contribution);
    const topBuyers = buyerScores.slice(0, 3).map((b) => b.wallet);

    return {
      mint,
      score,
      buyCount,
      sellCount,
      netFlow,
      topBuyers,
      computedAt: now,
    };
  }

  /**
   * Quick S_SM(t) lookup. Hot path safe.
   */
  getScore(mint: string): number {
    return this.computeSignal(mint)?.score ?? 0;
  }

  /**
   * Start real-time monitoring (WebSocket subscriptions for top wallets).
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Sort wallets by trust score and subscribe to top N
    const sorted = [...this.wallets.values()]
      .sort((a, b) => b.trustScore - a.trustScore)
      .slice(0, MAX_WALLETS);

    console.log(`💰 [SmartMoneyTracker] Subscribing to ${sorted.length} wallets...`);

    for (const wallet of sorted) {
      try {
        const pubkey = new PublicKey(wallet.address);
        const subId = this.connection.onAccountChange(
          pubkey,
          (accountInfo) => {
            // Account changed — parse for token transfers
            this.handleAccountChange(wallet.address, accountInfo);
          },
          'confirmed',
        );
        this.subscriptions.set(wallet.address, subId);
      } catch {
        // silencieux — certains wallets invalides
      }
    }

    // Batch query for remaining wallets every 30s
    this.batchInterval = setInterval(() => {
      this.batchQueryWallets().catch(() => {});
    }, BATCH_INTERVAL_MS);

    console.log(
      `✅ [SmartMoneyTracker] Started: ${this.subscriptions.size} live subscriptions`,
    );
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }

    for (const [, subId] of this.subscriptions) {
      try {
        await this.connection.removeAccountChangeListener(subId);
      } catch {
        // silencieux
      }
    }
    this.subscriptions.clear();
    console.log('✅ [SmartMoneyTracker] Stopped');
  }

  private handleAccountChange(_wallet: string, _accountInfo: unknown): void {
    // In production: parse token account changes to detect BUY/SELL
    // For now, this is a hook for future implementation
    // The actual trade recording comes from transaction parsing
  }

  private async batchQueryWallets(): Promise<void> {
    // Batch query all tracked wallets for recent transactions
    // Uses getSignaturesForAddress in batches to detect new trades
    // This fills in trades for wallets not on live WebSocket
    // Implementation deferred to when we have real wallet data
  }

  getStats() {
    return {
      ...this.stats,
      liveSubscriptions: this.subscriptions.size,
      trackedMints: this.trades.size,
    };
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _tracker: SmartMoneyTracker | null = null;

export function getSmartMoneyTracker(): SmartMoneyTracker {
  if (!_tracker) {
    _tracker = new SmartMoneyTracker();
  }
  return _tracker;
}
