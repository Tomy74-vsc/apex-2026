#!/usr/bin/env bun
/**
 * Export curve_snapshots / curve_outcomes / paper trades to CSV for Excel or training pipelines.
 * - curve_training_labeled.csv : snapshots HOT (features) JOIN outcomes (labels) — dataset supervisé principal
 * Usage: bun scripts/export-ml-dataset.ts [path/to/apex.db] [--last-snapshot-per-mint] [--snapshots-without-outcome]
 * Env: EXPORT_ML_LAST_SNAPSHOT_ONLY=1 — même effet que le flag (dataset supervisé : 1 ligne / mint).
 * Env: EXPORT_ML_UNLABELED_SNAPSHOTS=1 — exporte curve_snapshots_unlabeled.csv (mints sans outcome).
 */

import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const lastSnapshotPerMint =
  argv.includes('--last-snapshot-per-mint') ||
  (process.env.EXPORT_ML_LAST_SNAPSHOT_ONLY ?? '').trim() === '1';
const exportUnlabeledSnapshots =
  argv.includes('--snapshots-without-outcome') ||
  (process.env.EXPORT_ML_UNLABELED_SNAPSHOTS ?? '').trim() === '1';
const dbPath = argv.find((a) => !a.startsWith('-')) ?? 'data/apex.db';

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  const lines = [
    headers.map(csvCell).join(','),
    ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(',')),
  ];
  return lines.join('\n');
}

const db = new Database(dbPath, { readonly: true, create: false });

if (lastSnapshotPerMint) {
  console.log('📦 [export:ml] Mode: dernière snapshot par mint (JOIN outcomes)');
}

try {
  const snapshots = db.query('SELECT * FROM curve_snapshots ORDER BY timestamp_ms DESC LIMIT 50000').all() as Record<
    string,
    unknown
  >[];
  if (snapshots.length > 0) {
    const out = 'data/curve_snapshots.csv';
    await mkdir(dirname(out), { recursive: true });
    await Bun.write(out, rowsToCsv(snapshots));
    console.log(`✅ Exported ${snapshots.length} snapshots → ${out}`);
  } else {
    console.log('⚠️ No curve_snapshots rows');
  }

  const outcomes = db.query('SELECT * FROM curve_outcomes ORDER BY resolved_at DESC').all() as Record<
    string,
    unknown
  >[];
  if (outcomes.length > 0) {
    const out = 'data/curve_outcomes.csv';
    await mkdir(dirname(out), { recursive: true });
    await Bun.write(out, rowsToCsv(outcomes));
    console.log(`✅ Exported ${outcomes.length} outcomes → ${out}`);
  } else {
    console.log('⚠️ No curve_outcomes rows');
  }

  try {
    const labeledSql = lastSnapshotPerMint
      ? `
      SELECT
        s.*,
        o.graduated AS label_graduated,
        o.eviction_reason AS label_eviction_reason,
        o.final_progress AS label_final_progress,
        o.final_sol AS label_final_sol,
        o.duration_s AS label_duration_s,
        o.snapshots_count AS label_outcome_snapshot_count,
        o.resolved_at AS label_resolved_at
      FROM curve_snapshots s
      INNER JOIN (
        SELECT mint, MAX(timestamp_ms) AS max_ts
        FROM curve_snapshots
        GROUP BY mint
      ) latest ON s.mint = latest.mint AND s.timestamp_ms = latest.max_ts
      INNER JOIN curve_outcomes o ON s.mint = o.mint
      LIMIT 100000
    `
      : `
      SELECT
        s.*,
        o.graduated AS label_graduated,
        o.eviction_reason AS label_eviction_reason,
        o.final_progress AS label_final_progress,
        o.final_sol AS label_final_sol,
        o.duration_s AS label_duration_s,
        o.snapshots_count AS label_outcome_snapshot_count,
        o.resolved_at AS label_resolved_at
      FROM curve_snapshots s
      INNER JOIN curve_outcomes o ON s.mint = o.mint
      ORDER BY s.timestamp_ms DESC
      LIMIT 100000
    `;
    const labeled = db.query(labeledSql).all() as Record<string, unknown>[];
    if (labeled.length > 0) {
      const out = 'data/curve_training_labeled.csv';
      await mkdir(dirname(out), { recursive: true });
      await Bun.write(out, rowsToCsv(labeled));
      console.log(
        `✅ Exported ${labeled.length} labeled rows (snapshots+outcomes) → ${out} (supervisé ML${lastSnapshotPerMint ? ', last snapshot / mint' : ''})`,
      );
    } else {
      console.log('⚠️ No labeled rows (need both curve_snapshots and curve_outcomes for same mints)');
    }
  } catch (e) {
    console.log('⚠️ Labeled export skipped:', (e as Error).message);
  }

  if (exportUnlabeledSnapshots) {
    try {
      const unlabeled = db
        .query(
          `
        SELECT s.*
        FROM curve_snapshots s
        LEFT JOIN curve_outcomes o ON s.mint = o.mint
        WHERE o.mint IS NULL
        ORDER BY s.timestamp_ms DESC
        LIMIT 100000
      `,
        )
        .all() as Record<string, unknown>[];
      if (unlabeled.length > 0) {
        const out = 'data/curve_snapshots_unlabeled.csv';
        await mkdir(dirname(out), { recursive: true });
        await Bun.write(out, rowsToCsv(unlabeled));
        console.log(
          `✅ Exported ${unlabeled.length} unlabeled snapshots (no curve_outcomes row) → ${out}`,
        );
      } else {
        console.log('⚠️ No unlabeled snapshots (all mints have outcomes or no snapshots)');
      }
    } catch (e) {
      console.log('⚠️ Unlabeled snapshots export skipped:', (e as Error).message);
    }
  }

  try {
    const reasonRows = db
      .query(
        `SELECT COALESCE(eviction_reason, '(null)') AS eviction_reason, COUNT(*) AS count
         FROM curve_outcomes GROUP BY eviction_reason ORDER BY count DESC`,
      )
      .all() as Record<string, unknown>[];
    if (reasonRows.length > 0) {
      const out = 'data/curve_outcomes_eviction_summary.csv';
      await mkdir(dirname(out), { recursive: true });
      await Bun.write(out, rowsToCsv(reasonRows));
      console.log(`✅ Exported eviction_reason breakdown → ${out}`);
    }
  } catch {
    /* optional */
  }

  let openCount = 0;
  try {
    const openRows = db.query('SELECT * FROM open_curve_positions').all() as Record<string, unknown>[];
    openCount = openRows.length;
    if (openRows.length > 0) {
      const out = 'data/open_curve_positions.csv';
      await mkdir(dirname(out), { recursive: true });
      await Bun.write(out, rowsToCsv(openRows));
      console.log(`✅ Exported ${openRows.length} open_curve_positions → ${out}`);
    }
  } catch {
    /* table may be missing on old DBs */
  }
  console.log(`📊 Open positions in DB: ${openCount}`);

  try {
    const whales = db.query('SELECT * FROM whale_wallets ORDER BY trust_score DESC').all() as Record<
      string,
      unknown
    >[];
    if (whales.length > 0) {
      const out = 'data/whale_wallets.csv';
      await mkdir(dirname(out), { recursive: true });
      await Bun.write(out, rowsToCsv(whales));
      console.log(`✅ Exported ${whales.length} whale_wallets → ${out}`);
    }
  } catch {
    console.log('⚠️ No whale_wallets table or empty');
  }

  try {
    const jsonlPath = 'data/paper_trades.jsonl';
    const raw = await Bun.file(jsonlPath).text();
    const lines = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    if (lines.length > 0) {
      const out = 'data/paper_trades.csv';
      await mkdir(dirname(out), { recursive: true });
      await Bun.write(out, rowsToCsv(lines));
      console.log(`✅ Exported ${lines.length} paper trades → ${out}`);
    }
  } catch {
    if ((process.env.PAPER_TRADE_LOG ?? '').trim() === '0') {
      console.log('⚠️ paper_trades.jsonl absent : PAPER_TRADE_LOG=0 (logging paper désactivé)');
    } else {
      console.log('⚠️ No paper_trades.jsonl or parse error');
    }
  }

  console.log('\n📊 RÉSUMÉ BASE DE DONNÉES :');
  const snapshotCount = (db.query('SELECT COUNT(*) as c FROM curve_snapshots').get() as { c: number })?.c ?? 0;
  const outcomeCount = (db.query('SELECT COUNT(*) as c FROM curve_outcomes').get() as { c: number })?.c ?? 0;
  console.log(`   Snapshots: ${snapshotCount}`);
  console.log(`   Outcomes: ${outcomeCount}`);

  if (outcomeCount > 0) {
    const graduated =
      (db.query('SELECT COUNT(*) as c FROM curve_outcomes WHERE graduated = 1').get() as { c: number })?.c ?? 0;
    const evicted = outcomeCount - graduated;
    console.log(`   Graduated: ${graduated} | Evicted: ${evicted}`);

    const reasons = db
      .query('SELECT eviction_reason, COUNT(*) as c FROM curve_outcomes GROUP BY eviction_reason ORDER BY c DESC')
      .all() as Array<{ eviction_reason: string | null; c: number }>;
    for (const r of reasons) {
      console.log(`     ${r.eviction_reason ?? '(null)'}: ${r.c}`);
    }
  }
} finally {
  db.close();
}
