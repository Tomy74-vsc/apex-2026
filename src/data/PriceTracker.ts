/**
 * PriceTracker — APEX-2026 Cold Path
 *
 * Labellise les tokens après leur détection via des checks de prix multi-horizon.
 * Alimente token_labels dans le Feature Store pour le training ML.
 *
 * Source de prix : DexScreener API (gratuite, sans clé)
 * Endpoint : GET https://api.dexscreener.com/latest/dex/tokens/{mint}
 */

import { getFeatureStore } from './FeatureStore.js';
import type { TokenLabelRecord } from '../types/index.js';
import { defaultDexScreenerTimeoutMs, fetchWithTimeout } from '../infra/fetchWithTimeout.js';

const HORIZONS_MS = [5_000, 30_000, 120_000, 600_000] as const;
type HorizonMs = (typeof HORIZONS_MS)[number];

const DEXSCREENER_URL = 'https://api.dexscreener.com/latest/dex/tokens';
const MAX_TRACKED = 500;
const DEXSCREENER_RATE_LIMIT_MS = 300;

interface TrackedToken {
  mint: string;
  entryPriceUsdc: number;
  t_act: number;
  minPriceSeen: number;
  labelsCompleted: Set<number>;
  timers: ReturnType<typeof setTimeout>[];
}

export class PriceTracker {
  private tracked: Map<string, TrackedToken> = new Map();
  private lastFetchMs = 0;

  private stats = {
    tracked: 0,
    labeled: 0,
    skipped: 0,
    errors: 0,
  };

  track(mint: string, entryPriceUsdc: number, t_act: number): void {
    try {
      if (this.tracked.size >= MAX_TRACKED) {
        const oldest = this.tracked.keys().next().value;
        if (oldest) {
          this.cancel(oldest);
        }
      }

      if (this.tracked.has(mint)) return;

      if (!entryPriceUsdc || entryPriceUsdc <= 0) {
        console.warn(
          `⚠️  [PriceTracker] Prix d'entrée invalide pour ${mint.slice(0, 8)} → skip`,
        );
        return;
      }

      const entry: TrackedToken = {
        mint,
        entryPriceUsdc,
        t_act,
        minPriceSeen: entryPriceUsdc,
        labelsCompleted: new Set(),
        timers: [],
      };

      for (const horizonMs of HORIZONS_MS) {
        const timer = setTimeout(async () => {
          await this.checkAndLabel(mint, horizonMs);
        }, horizonMs);
        entry.timers.push(timer);
      }

      this.tracked.set(mint, entry);
      this.stats.tracked += 1;
    } catch (err) {
      this.stats.errors += 1;
      console.warn(`⚠️  [PriceTracker] track error: ${err}`);
    }
  }

  cancel(mint: string): void {
    const entry = this.tracked.get(mint);
    if (!entry) return;
    for (const timer of entry.timers) {
      clearTimeout(timer);
    }
    this.tracked.delete(mint);
  }

  getStats() {
    return { ...this.stats, activeTracked: this.tracked.size };
  }

  private async checkAndLabel(mint: string, horizonMs: HorizonMs): Promise<void> {
    const entry = this.tracked.get(mint);
    if (!entry) {
      this.stats.skipped += 1;
      return;
    }

    const horizonS = horizonMs / 1000;
    if (entry.labelsCompleted.has(horizonS)) return;

    try {
      const now = Date.now();
      const sinceLastFetch = now - this.lastFetchMs;
      if (sinceLastFetch < DEXSCREENER_RATE_LIMIT_MS) {
        await Bun.sleep(DEXSCREENER_RATE_LIMIT_MS - sinceLastFetch);
      }

      const priceNow = await this.fetchPrice(mint);
      this.lastFetchMs = Date.now();

      if (priceNow === null) {
        this.stats.skipped += 1;
        console.warn(
          `⚠️  [PriceTracker] Prix indisponible pour ${mint.slice(
            0,
            8,
          )} à T+${horizonS}s → skip`,
        );
        return;
      }

      if (priceNow < entry.minPriceSeen) {
        entry.minPriceSeen = priceNow;
      }

      const retLog = Math.log(priceNow / entry.entryPriceUsdc);
      const drawdown = entry.minPriceSeen / entry.entryPriceUsdc - 1;

      const label: TokenLabelRecord = {
        mint,
        horizonS,
        retLog,
        drawdown,
        execOk: null,
        labeledAt: Date.now(),
      };

      getFeatureStore().appendLabel(label);
      entry.labelsCompleted.add(horizonS);
      this.stats.labeled += 1;

      const retPct = (Math.exp(retLog) - 1) * 100;
      const ddPct = drawdown * 100;
      const emoji =
        retPct >= 20 ? '🚀' : retPct >= 0 ? '📈' : retPct >= -20 ? '📉' : '💀';
      console.log(
        `${emoji} [PriceTracker] ${mint.slice(0, 8)} T+${horizonS}s` +
          ` | ret=${retPct >= 0 ? '+' : ''}${retPct.toFixed(1)}%` +
          ` | dd=${ddPct.toFixed(1)}%` +
          ` | entry=${entry.entryPriceUsdc.toFixed(8)}` +
          ` | now=${priceNow.toFixed(8)}`,
      );

      if (entry.labelsCompleted.size === HORIZONS_MS.length) {
        this.tracked.delete(mint);
      }
    } catch (err) {
      this.stats.errors += 1;
      console.warn(
        `⚠️  [PriceTracker] checkAndLabel error [${mint.slice(
          0,
          8,
        )}] T+${horizonS}s: ${err}`,
      );
    }
  }

  private async fetchPrice(mint: string): Promise<number | null> {
    try {
      const resp = await fetchWithTimeout(
        `${DEXSCREENER_URL}/${mint}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 APEX-2026-HFT',
          },
        },
        defaultDexScreenerTimeoutMs(),
      );

      if (!resp.ok) return null;

      const data = (await resp.json()) as {
        pairs?: Array<{
          priceUsd?: string;
          chainId?: string;
          dexId?: string;
          volume?: { h24?: number };
        }>;
      };

      if (!data.pairs || data.pairs.length === 0) return null;

      const solanaPairs = data.pairs
        .filter((p) => p.chainId === 'solana' && p.priceUsd)
        .sort(
          (a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0),
        );

      if (solanaPairs.length === 0) return null;

      const price = parseFloat(solanaPairs[0]!.priceUsd!);
      return Number.isNaN(price) || price <= 0 ? null : price;
    } catch {
      return null;
    }
  }
}

let _tracker: PriceTracker | null = null;

export function getPriceTracker(): PriceTracker {
  if (!_tracker) {
    _tracker = new PriceTracker();
  }
  return _tracker;
}

