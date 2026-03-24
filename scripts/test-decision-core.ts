#!/usr/bin/env bun
/**
 * Smoke DecisionCore (curve-prediction only) — pas de MarketScanner.
 * Usage: STRATEGY_MODE=curve-prediction bun scripts/test-decision-core.ts
 */

process.env.STRATEGY_MODE = 'curve-prediction';

import { DecisionCore } from '../src/engine/DecisionCore';

async function main() {
  console.log('🚀 Test DecisionCore — curve-prediction uniquement\n');

  const core = new DecisionCore({});

  await core.start();
  const stats = core.getStats();
  console.log('📊 Stats initiales (courbe):', stats);
  await core.stop();
  console.log('✅ OK — constructeur + start/stop sans sniper path');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
