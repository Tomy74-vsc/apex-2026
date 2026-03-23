/**
 * Phase A — append-only JSONL log of curve opens/closes for paper P&L audit (roadmapv3 M4).
 * Cold path only; never throws to callers.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CurvePosition } from './PositionManager.js';
import { getPositionManager } from './PositionManager.js';

const DEFAULT_PATH = 'data/paper_trades.jsonl';

function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

async function appendSafe(path: string, data: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, data, { encoding: 'utf8' });
  } catch {
    /* cold path */
  }
}

/**
 * Subscribe once to PositionManager. No-op if PAPER_TRADE_LOG=0.
 */
export function attachPaperTradeLogger(): void {
  if (process.env.PAPER_TRADE_LOG === '0') return;

  const path = process.env.PAPER_TRADE_LOG_PATH ?? DEFAULT_PATH;
  const pm = getPositionManager();

  pm.on('positionOpened', (p: CurvePosition) => {
    void appendSafe(
      path,
      line({
        kind: 'OPEN',
        t: Date.now(),
        mint: p.mint,
        entrySol: p.originalEntrySol,
        tokens: p.remainingTokens.toString(),
        progress: p.entryProgress,
        pGrad: p.entryPGrad,
        breakeven: p.entryBreakeven,
      }),
    );
  });

  pm.on('positionClosed', (p: CurvePosition) => {
    void appendSafe(
      path,
      line({
        kind: 'CLOSE',
        t: Date.now(),
        mint: p.mint,
        reason: p.exitReason,
        entrySol: p.originalEntrySol,
        exitSol: p.exitSolReceived,
        realizedPnlSOL: p.realizedPnlSOL,
        realizedPnlPct: p.realizedPnlPct,
        holdS: p.holdDurationS,
      }),
    );
  });

  console.log(`📝 [PaperTradeLogger] logging → ${path} (set PAPER_TRADE_LOG=0 to disable)`);
}
