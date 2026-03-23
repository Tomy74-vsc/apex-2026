/**
 * DexScreener token-boosts feed → social signal + optional HOT promotion for tracked curves.
 * Free HTTP, 5s timeout, silent errors (guérilla path).
 */

import { EventEmitter } from 'events';

const DEX_BOOST_URL = 'https://api.dexscreener.com/token-boosts/latest/v1';

export interface SocialBoostPayload {
  mint: string;
  source: 'dexscreener_boost';
  boostAmount: number;
}

interface DexBoostRow {
  tokenAddress?: string;
  chainId?: string;
  amount?: number;
  totalAmount?: number;
}

let singleton: SocialTrendScanner | null = null;

export function getSocialTrendScanner(): SocialTrendScanner {
  if (!singleton) singleton = new SocialTrendScanner();
  return singleton;
}

export class SocialTrendScanner extends EventEmitter {
  private boostInterval: ReturnType<typeof setInterval> | null = null;
  /** Dedup for emit — LRU-trimmed so rediscovery after eviction can re-fire. */
  private knownBoosts = new Set<string>();
  /** Mints present in the latest API response (Solana only). */
  private boostedMints = new Set<string>();
  private readonly POLL_MS = 30_000;

  async start(): Promise<void> {
    if (this.boostInterval !== null) return;

    void this.pollBoosts();
    this.boostInterval = setInterval(() => {
      void this.pollBoosts();
    }, this.POLL_MS);

    console.log('🔍 [SocialTrend] Started — DexScreener boosts every 30s');
  }

  private async pollBoosts(): Promise<void> {
    const t0 = performance.now();
    try {
      const resp = await fetch(DEX_BOOST_URL, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) return;

      const data = (await resp.json()) as unknown;
      if (!Array.isArray(data)) return;

      const solanaThisPoll = new Set<string>();

      for (const raw of data) {
        const item = raw as DexBoostRow;
        if (item.chainId !== 'solana' || !item.tokenAddress) continue;
        solanaThisPoll.add(item.tokenAddress);
      }

      this.boostedMints = solanaThisPoll;

      for (const item of data as DexBoostRow[]) {
        if (item.chainId !== 'solana' || !item.tokenAddress) continue;
        const addr = item.tokenAddress;
        if (this.knownBoosts.has(addr)) continue;

        this.knownBoosts.add(addr);
        const boostAmount = item.amount ?? item.totalAmount ?? 0;
        this.emit('socialBoost', {
          mint: addr,
          source: 'dexscreener_boost',
          boostAmount,
        } satisfies SocialBoostPayload);

        console.log(`📢 [DexScreener] Boost detected: ${addr.slice(0, 8)}… | ⏱️${(performance.now() - t0).toFixed(0)}ms`);
      }

      if (this.knownBoosts.size > 10_000) {
        const arr = Array.from(this.knownBoosts);
        this.knownBoosts = new Set(arr.slice(-5_000));
      }
    } catch {
      /* cold path */
    }
  }

  isBoosted(mint: string): boolean {
    return this.boostedMints.has(mint);
  }

  stop(): void {
    if (this.boostInterval !== null) {
      clearInterval(this.boostInterval);
      this.boostInterval = null;
    }
  }
}
