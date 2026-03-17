/**
 * OutcomeTracker — APEX-2026 V3 Cold Path
 *
 * Asynchronous job that evaluates the outcome of feature snapshots
 * at T+5min and T+30min. Labels snapshots as WIN/LOSS/NEUTRAL
 * and writes TokenOutcomeRecord to the Feature Store.
 *
 * Architecture: fire-and-forget timers per snapshot.
 * Price source: DexScreener API (free, no key).
 * Never throws to caller — all errors caught internally.
 */

import { getFeatureStore } from '../data/FeatureStore.js';
import type { TokenOutcomeRecord } from '../types/index.js';

const DEXSCREENER_URL = 'https://api.dexscreener.com/latest/dex/tokens';
const FETCH_TIMEOUT_MS = 3_000;
const RATE_LIMIT_MS = 300;

const HORIZON_5M_MS = 5 * 60_000;
const HORIZON_30M_MS = 30 * 60_000;

const WIN_THRESHOLD = 0.05;  // +5% = WIN
const LOSS_THRESHOLD = -0.05; // -5% = LOSS

const MAX_TRACKED = 500;

interface TrackedSnapshot {
  featureId: string;
  mint: string;
  entryPrice: number;
  createdAt: number;
  minPriceSeen: number;
  timers: ReturnType<typeof setTimeout>[];
  priceChange5m: number | null;
  maxDrawdown5m: number | null;
}

export class OutcomeTracker {
  private tracked: Map<string, TrackedSnapshot> = new Map();
  private lastFetchMs = 0;
  private stats = {
    tracked: 0,
    labeled: 0,
    errors: 0,
  };

  /**
   * Start tracking a feature snapshot for outcome labeling.
   * Call this after each feature snapshot is recorded.
   */
  track(featureId: string, mint: string, entryPrice: number): void {
    try {
      if (this.tracked.size >= MAX_TRACKED) {
        const oldest = this.tracked.keys().next().value;
        if (oldest) this.cancel(oldest);
      }

      if (this.tracked.has(featureId) || entryPrice <= 0) return;

      const entry: TrackedSnapshot = {
        featureId,
        mint,
        entryPrice,
        createdAt: Date.now(),
        minPriceSeen: entryPrice,
        timers: [],
        priceChange5m: null,
        maxDrawdown5m: null,
      };

      // Schedule T+5min check
      entry.timers.push(
        setTimeout(() => this.checkHorizon(featureId, '5m'), HORIZON_5M_MS),
      );

      // Schedule T+30min check
      entry.timers.push(
        setTimeout(() => this.checkHorizon(featureId, '30m'), HORIZON_30M_MS),
      );

      this.tracked.set(featureId, entry);
      this.stats.tracked++;
    } catch (err) {
      this.stats.errors++;
      console.warn(`⚠️  [OutcomeTracker] track error: ${err}`);
    }
  }

  cancel(featureId: string): void {
    const entry = this.tracked.get(featureId);
    if (!entry) return;
    for (const t of entry.timers) clearTimeout(t);
    this.tracked.delete(featureId);
  }

  getStats() {
    return { ...this.stats, active: this.tracked.size };
  }

  private async checkHorizon(featureId: string, horizon: '5m' | '30m'): Promise<void> {
    const entry = this.tracked.get(featureId);
    if (!entry) return;

    try {
      // Rate limit
      const wait = RATE_LIMIT_MS - (Date.now() - this.lastFetchMs);
      if (wait > 0) await Bun.sleep(wait);

      const price = await this.fetchPrice(entry.mint);
      this.lastFetchMs = Date.now();

      if (price === null) {
        console.warn(
          `⚠️  [OutcomeTracker] Price unavailable for ${entry.mint.slice(0, 8)} at T+${horizon}`,
        );
        return;
      }

      if (price < entry.minPriceSeen) entry.minPriceSeen = price;

      const change = (price - entry.entryPrice) / entry.entryPrice;
      const drawdown = (entry.minPriceSeen - entry.entryPrice) / entry.entryPrice;

      if (horizon === '5m') {
        entry.priceChange5m = change;
        entry.maxDrawdown5m = drawdown;

        const emoji = change >= 0.2 ? '🚀' : change >= 0 ? '📈' : change >= -0.2 ? '📉' : '💀';
        console.log(
          `${emoji} [OutcomeTracker] ${entry.mint.slice(0, 8)} T+5m | ` +
            `change=${(change * 100).toFixed(1)}% | dd=${(drawdown * 100).toFixed(1)}%`,
        );
      }

      if (horizon === '30m') {
        const label: TokenOutcomeRecord['label'] =
          (entry.priceChange5m ?? change) >= WIN_THRESHOLD
            ? 'WIN'
            : (entry.priceChange5m ?? change) <= LOSS_THRESHOLD
              ? 'LOSS'
              : 'NEUTRAL';

        const outcome: TokenOutcomeRecord = {
          id: crypto.randomUUID(),
          featureId: entry.featureId,
          priceChange5m: entry.priceChange5m ?? change,
          maxDrawdown5m: entry.maxDrawdown5m ?? drawdown,
          volumeChange5m: 0, // TODO P2: compute from on-chain volume data
          label,
          priceChange30m: change,
          createdAt: Date.now(),
        };

        getFeatureStore().appendOutcome(outcome);
        this.stats.labeled++;
        this.tracked.delete(featureId);

        const emoji = label === 'WIN' ? '✅' : label === 'LOSS' ? '❌' : '⚪';
        console.log(
          `${emoji} [OutcomeTracker] ${entry.mint.slice(0, 8)} LABELED=${label} | ` +
            `5m=${((entry.priceChange5m ?? 0) * 100).toFixed(1)}% | 30m=${(change * 100).toFixed(1)}%`,
        );
      }
    } catch (err) {
      this.stats.errors++;
      console.warn(`⚠️  [OutcomeTracker] checkHorizon error: ${err}`);
    }
  }

  private async fetchPrice(mint: string): Promise<number | null> {
    try {
      const resp = await fetch(`${DEXSCREENER_URL}/${mint}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'Mozilla/5.0 APEX-2026-HFT' },
      });

      if (!resp.ok) return null;

      const data = (await resp.json()) as {
        pairs?: Array<{
          priceUsd?: string;
          chainId?: string;
          volume?: { h24?: number };
        }>;
      };

      if (!data.pairs?.length) return null;

      const solanaPairs = data.pairs
        .filter((p) => p.chainId === 'solana' && p.priceUsd)
        .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0));

      if (!solanaPairs.length) return null;

      const price = parseFloat(solanaPairs[0]!.priceUsd!);
      return Number.isNaN(price) || price <= 0 ? null : price;
    } catch {
      return null;
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _tracker: OutcomeTracker | null = null;

export function getOutcomeTracker(): OutcomeTracker {
  if (!_tracker) {
    _tracker = new OutcomeTracker();
  }
  return _tracker;
}
