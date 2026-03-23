#!/usr/bin/env bun
/**
 * Smoke test xAI (Grok) — Responses API + outil web_search (search_parameters obsolète → 410).
 * Usage: depuis la racine du repo, avec .env chargé par Bun :
 *   bun run verify:xai
 */

import { getGrokXScanner } from '../src/social/GrokXScanner.js';

const mint = 'DezXAZ8z7PnrnRJ7k6s1h2yFyw3xoTpN12AG9ZEG1Qt'; // BONK (exemple stable)
const ticker = 'BONK';

async function main(): Promise<void> {
  const g = getGrokXScanner();
  if (!g.hasApiKey()) {
    console.log('❌ XAI_API_KEY manquant dans .env');
    process.exit(1);
  }
  const toMs = parseInt(process.env.XAI_RESPONSES_TIMEOUT_MS ?? '120000', 10) || 120_000;
  console.log(`🚀 Test GrokX (web_search côté xAI, timeout ${toMs / 1000}s — sois patient)…`);
  const r = await g.analyzeToken(ticker, mint);
  if (!r) {
    console.log('❌ Réponse null — voir logs ⚠️ [GrokX] ci-dessus (HTTP ou parse JSON)');
    process.exit(2);
  }
  console.log('✅ OK:', {
    hypeLevel: r.hypeLevel,
    sentiment: r.sentiment,
    mentionCount: r.mentionCount,
    confidence: r.confidence,
    latencyMs: r.latencyMs,
  });
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
