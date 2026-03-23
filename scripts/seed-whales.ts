#!/usr/bin/env bun
/**
 * Bootstrap whale_wallets avec des adresses smart-money connues.
 * Usage: bun scripts/seed-whales.ts
 */

import { getFeatureStore } from '../src/data/FeatureStore.js';
import { getWhaleWalletDB } from '../src/data/WhaleWalletDB.js';

const KNOWN_WHALES: Array<{ address: string; label: string; trust_score: number }> = [
  // { address: '<BASE58_PUBKEY>', label: 'label', trust_score: 0.75 },
];

const dbPath = process.env.FEATURE_STORE_PATH ?? 'data/apex.db';
getFeatureStore(dbPath);
const db = getWhaleWalletDB();

for (const w of KNOWN_WHALES) {
  db.addWhale(w.address, w.label, 'manual_seed', w.trust_score);
}

console.log(`🐋 Seeded ${KNOWN_WHALES.length} whales → ${dbPath}`);
