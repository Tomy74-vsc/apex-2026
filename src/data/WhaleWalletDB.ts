/**
 * Persistent whale / smart-money registry (SQLite via FeatureStore connection).
 * Cold path only — never throws to callers.
 */

import type { Database } from 'bun:sqlite';
import { getFeatureStore } from './FeatureStore.js';
import { getSmartMoneyTracker, type WalletProfile } from '../ingestors/SmartMoneyTracker.js';
import { getAIBrain } from '../engine/AIBrain.js';

export interface WhaleWallet {
  address: string;
  label: string;
  trustScore: number;
  tokensBought: number;
  tokensGraduated: number;
  winRate: number;
  lastSeenMs: number;
  discoveredVia: string;
  createdAt: number;
  updatedAt: number;
}

let singleton: WhaleWalletDB | null = null;

export function getWhaleWalletDB(): WhaleWalletDB {
  if (!singleton) {
    singleton = new WhaleWalletDB(getFeatureStore().getSqliteHandle());
  }
  return singleton;
}

export class WhaleWalletDB {
  constructor(private readonly db: Database) {}

  addWhale(address: string, label: string, discoveredVia: string, trustScore = 0.5): void {
    try {
      const now = Date.now();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO whale_wallets (
            address, label, trust_score, tokens_bought, tokens_graduated, win_rate,
            last_seen_ms, discovered_via, created_at, updated_at
          ) VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?, ?)`,
        )
        .run(address, label, trustScore, discoveredVia, now, now);
    } catch {
      /* cold path */
    }
  }

  updateStats(address: string, graduated: boolean): void {
    try {
      const row = this.db
        .prepare(
          'SELECT tokens_bought, tokens_graduated FROM whale_wallets WHERE address = ?',
        )
        .get(address) as { tokens_bought: number; tokens_graduated: number } | null;
      if (!row) return;

      const bought = row.tokens_bought + 1;
      const graduatedCount = row.tokens_graduated + (graduated ? 1 : 0);
      const winRate = bought > 0 ? graduatedCount / bought : 0;
      const now = Date.now();

      this.db
        .prepare(
          `UPDATE whale_wallets SET
            tokens_bought = ?,
            tokens_graduated = ?,
            win_rate = ?,
            last_seen_ms = ?,
            updated_at = ?
          WHERE address = ?`,
        )
        .run(bought, graduatedCount, winRate, now, now, address);
    } catch {
      /* cold path */
    }
  }

  getTopWhales(limit = 100): WhaleWallet[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT address, label, trust_score, tokens_bought, tokens_graduated, win_rate,
                  last_seen_ms, discovered_via, created_at, updated_at
           FROM whale_wallets ORDER BY trust_score DESC LIMIT ?`,
        )
        .all(limit) as Array<{
        address: string;
        label: string;
        trust_score: number;
        tokens_bought: number;
        tokens_graduated: number;
        win_rate: number;
        last_seen_ms: number;
        discovered_via: string;
        created_at: number;
        updated_at: number;
      }>;

      return rows.map((r) => ({
        address: r.address,
        label: r.label,
        trustScore: r.trust_score,
        tokensBought: r.tokens_bought,
        tokensGraduated: r.tokens_graduated,
        winRate: r.win_rate,
        lastSeenMs: r.last_seen_ms,
        discoveredVia: r.discovered_via,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    } catch {
      return [];
    }
  }

  isWhale(address: string): boolean {
    try {
      const row = this.db
        .prepare('SELECT 1 as x FROM whale_wallets WHERE address = ? LIMIT 1')
        .get(address) as { x: number } | null;
      return row != null;
    } catch {
      return false;
    }
  }

  getWhaleCount(): number {
    try {
      const row = this.db.prepare('SELECT COUNT(*) as c FROM whale_wallets').get() as { c: number } | null;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  loadIntoSmartMoneyTracker(): void {
    try {
      const whales = this.getTopWhales(100);
      const profiles: WalletProfile[] = whales.map((w) => ({
        address: w.address,
        trustScore: w.trustScore,
        label: w.label,
        lastSeen: w.lastSeenMs > 0 ? w.lastSeenMs : w.updatedAt,
      }));
      getSmartMoneyTracker().addWallets(profiles);
      getAIBrain().setSmartMoneyList(whales.map((w) => w.address));
      console.log(`🐋 [WhaleDB] Loaded ${whales.length} whales into SmartMoneyTracker + WalletScorer`);
    } catch {
      /* cold path */
    }
  }
}
