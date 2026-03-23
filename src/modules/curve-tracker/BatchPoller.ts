import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import {
  decodeBondingCurve,
  type BondingCurveState,
} from '../../types/bonding-curve.js';

const BATCH_SIZE = 100;
const MAX_BATCHES_PER_POLL = 10;
const INTER_BATCH_DELAY_MS = 200;
const BATCH_TIMEOUT_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 2_000;
const MIN_POLL_GAP_MS = 500;

export class BatchPoller extends EventEmitter {
  private readonly connections: Connection[];
  private readonly tracked: Map<string, PublicKey> = new Map();
  private readonly lastKnownState: Map<string, bigint> = new Map();
  private backoffMs = 0;
  private lastPollEndMs = 0;
  private consecutiveErrors = 0;

  constructor(connections: Connection[]) {
    super();
    if (connections.length === 0) {
      throw new Error('BatchPoller requires at least one Connection');
    }
    this.connections = connections;
  }

  register(mint: string, bondingCurvePDA: PublicKey): void {
    this.tracked.set(mint, bondingCurvePDA);
  }

  unregister(mint: string): void {
    this.tracked.delete(mint);
    this.lastKnownState.delete(mint);
  }

  getTrackedCount(): number {
    return this.tracked.size;
  }

  /**
   * Poll a specific set of mints. Returns decoded states (null if account missing/invalid).
   */
  async pollBatch(mints: string[]): Promise<Map<string, BondingCurveState | null>> {
    const results = new Map<string, BondingCurveState | null>();
    if (mints.length === 0) return results;

    const pdas: { mint: string; pda: PublicKey }[] = [];
    for (const mint of mints) {
      const pda = this.tracked.get(mint);
      if (pda) pdas.push({ mint, pda });
    }

    const batches: { mint: string; pda: PublicKey }[][] = [];
    for (let i = 0; i < pdas.length && batches.length < MAX_BATCHES_PER_POLL; i += BATCH_SIZE) {
      batches.push(pdas.slice(i, i + BATCH_SIZE));
    }

    // Enforce minimum gap between polls to avoid burst-hammering the RPC
    const sinceLastPoll = Date.now() - this.lastPollEndMs;
    if (sinceLastPoll < MIN_POLL_GAP_MS) {
      await this.sleep(MIN_POLL_GAP_MS - sinceLastPoll);
    }

    const t0 = performance.now();
    let decoded = 0;

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi]!;
      const keys = batch.map((b) => b.pda);

      try {
        if (this.backoffMs > 0) {
          await this.sleep(this.backoffMs);
        }

        const accounts = await this.rpcRace(keys);
        this.backoffMs = 0;
        this.consecutiveErrors = 0;

        for (let i = 0; i < batch.length; i++) {
          const entry = batch[i]!;
          const accountInfo = accounts[i];

          if (!accountInfo || !accountInfo.data) {
            results.set(entry.mint, null);
            continue;
          }

          try {
            const state = decodeBondingCurve(Buffer.from(accountInfo.data));
            results.set(entry.mint, state);
            decoded++;

            const prevRealSol = this.lastKnownState.get(entry.mint);
            if (prevRealSol === undefined || prevRealSol !== state.realSolReserves) {
              this.lastKnownState.set(entry.mint, state.realSolReserves);
              this.emit('stateUpdate', entry.mint, state);
            }

            if (state.complete) {
              this.emit('graduated', entry.mint, state);
            }
          } catch {
            results.set(entry.mint, null);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('429') || msg.includes('Too Many Requests')) {
          this.consecutiveErrors++;
          this.backoffMs = Math.min(
            this.backoffMs > 0 ? this.backoffMs * 2 : INITIAL_BACKOFF_MS,
            MAX_BACKOFF_MS,
          );
          if (this.consecutiveErrors <= 3) {
            console.warn(`⚠️ [BatchPoller] 429 — backoff ${this.backoffMs}ms (streak: ${this.consecutiveErrors})`);
          }
        }
        this.emit('error', err instanceof Error ? err : new Error(msg));
      }

      if (bi < batches.length - 1) {
        await this.sleep(INTER_BATCH_DELAY_MS);
      }
    }

    this.lastPollEndMs = Date.now();
    const elapsed = (performance.now() - t0).toFixed(1);
    if (decoded >= 5) {
      console.log(`📊 [BatchPoller] Polled ${decoded} curves in ${elapsed}ms`);
    }

    return results;
  }

  /**
   * Poll all tracked mints.
   */
  async pollAll(): Promise<void> {
    const allMints = Array.from(this.tracked.keys());
    if (allMints.length === 0) return;
    await this.pollBatch(allMints);
  }

  /**
   * RPC racing: fastest connection wins.
   */
  private async rpcRace(
    keys: PublicKey[],
  ): Promise<(import('@solana/web3.js').AccountInfo<Buffer> | null)[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS);

    try {
      if (this.connections.length === 1) {
        const conn = this.connections[0];
        if (!conn) return [];
        return await conn.getMultipleAccountsInfo(keys, 'confirmed');
      }

      return await Promise.any(
        this.connections.map((conn) =>
          conn.getMultipleAccountsInfo(keys, 'confirmed'),
        ),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
