/**
 * Logique partagée seed-whales / discover-whales (roadmapv3 alias).
 */

import { getFeatureStore } from '../../src/data/FeatureStore.js';
import { getWhaleWalletDB } from '../../src/data/WhaleWalletDB.js';

export interface WhaleSeedRow {
  address: string;
  label: string;
  trust_score: number;
}

export const DEFAULT_KNOWN_WHALES: WhaleSeedRow[] = [
  // { address: '<BASE58_PUBKEY>', label: 'label', trust_score: 0.75 },
];

export function runWhaleSeed(whales: WhaleSeedRow[] = DEFAULT_KNOWN_WHALES): void {
  const dbPath = process.env.FEATURE_STORE_PATH ?? 'data/apex.db';
  getFeatureStore(dbPath);
  const db = getWhaleWalletDB();
  for (const w of whales) {
    db.addWhale(w.address, w.label, 'manual_seed', w.trust_score);
  }
  console.log(`🐋 Seeded ${whales.length} whales → ${dbPath}`);
}
