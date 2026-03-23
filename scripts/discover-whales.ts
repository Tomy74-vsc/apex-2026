#!/usr/bin/env bun
/**
 * Alias roadmapv3 `discover-whales.ts` — même comportement que `seed-whales.ts`.
 * Usage: bun scripts/discover-whales.ts
 */

import { DEFAULT_KNOWN_WHALES, runWhaleSeed } from './lib/whale-seed.js';

runWhaleSeed(DEFAULT_KNOWN_WHALES);
