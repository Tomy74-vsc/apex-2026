/**
 * Concentration holders on-chain (top-10 supply / total supply), cold path, désactivé par défaut.
 * Alimente un cache lu de façon synchrone par GraduationPredictor / WalletScorer.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

function enabled(): boolean {
  const v = (process.env.HOLDER_DISTRIBUTION_ENABLED ?? '').toLowerCase().trim();
  return v === '1' || v === 'true' || v === 'yes';
}

function ttlMs(): number {
  const n = parseInt(process.env.HOLDER_DISTRIBUTION_TTL_MS ?? '120000', 10);
  return Number.isFinite(n) && n >= 30_000 ? n : 120_000;
}

function timeoutMs(): number {
  const n = parseInt(process.env.HOLDER_DISTRIBUTION_RPC_TIMEOUT_MS ?? '8000', 10);
  return Number.isFinite(n) && n >= 2000 ? n : 8000;
}

function buildConnections(): Connection[] {
  const conns: Connection[] = [];
  const helius = process.env.HELIUS_RPC_URL ?? process.env.RPC_URL;
  const qn = process.env.QUICKNODE_RPC_URL;
  if (helius) conns.push(new Connection(helius, 'confirmed'));
  if (qn) conns.push(new Connection(qn, 'confirmed'));
  if (conns.length === 0) {
    conns.push(new Connection('https://api.mainnet-beta.solana.com', 'confirmed'));
  }
  return conns;
}

async function rpcRace<T>(conns: Connection[], fn: (c: Connection) => Promise<T>): Promise<T> {
  return Promise.any(conns.map((c) => fn(c)));
}

/**
 * Part du supply (0–1) détenue par les 10 plus gros comptes token (hors agrégation curve pump).
 */
export async function fetchTop10SupplyShare(mint: string): Promise<number | null> {
  if (!enabled()) return null;
  const mintPk = new PublicKey(mint);
  const conns = buildConnections();
  const ms = timeoutMs();

  const run = async (): Promise<number | null> => {
    const largest = await rpcRace(conns, (conn) =>
      conn.getTokenLargestAccounts(mintPk, 'confirmed'),
    );
    const rows = largest.value ?? [];
    if (rows.length === 0) return null;

    const balances: bigint[] = rows
      .map((acc) => {
        try {
          return BigInt(acc.amount);
        } catch {
          return 0n;
        }
      })
      .filter((b) => b > 0n);
    balances.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    const top10 = balances.slice(0, 10);
    const top10Sum = top10.reduce((s, b) => s + b, 0n);

    const mintInfo = await rpcRace(conns, (conn) => getMint(conn, mintPk));
    if (!mintInfo || mintInfo.supply === 0n) return null;

    const share = Number(top10Sum) / Number(mintInfo.supply);
    if (!Number.isFinite(share)) return null;
    return Math.max(0, Math.min(1, share));
  };

  try {
    return await Promise.race([
      run(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
  } catch {
    return null;
  }
}

let oracleSingleton: HolderDistributionOracle | null = null;

export class HolderDistributionOracle {
  private readonly cache = new Map<string, { share: number; at: number }>();
  private readonly inflight = new Map<string, Promise<void>>();

  isEnabled(): boolean {
    return enabled();
  }

  /** Lecture synchrone pour le prédicteur ; undefined = pas de donnée (utiliser proxy volume). */
  getCachedShare(mint: string): number | undefined {
    if (!enabled()) return undefined;
    const row = this.cache.get(mint);
    if (!row) return undefined;
    if (Date.now() - row.at > ttlMs()) return undefined;
    return row.share;
  }

  /** Cold path : met à jour le cache ; dédupliqué par mint. */
  scheduleRefresh(mint: string): void {
    if (!enabled()) return;
    if (this.inflight.has(mint)) return;
    const job = (async () => {
      try {
        const share = await fetchTop10SupplyShare(mint);
        if (share != null) {
          this.cache.set(mint, { share, at: Date.now() });
        }
      } catch {
        /* cold path */
      } finally {
        this.inflight.delete(mint);
      }
    })();
    this.inflight.set(mint, job);
  }

  pruneMint(mint: string): void {
    this.cache.delete(mint);
    this.inflight.delete(mint);
  }
}

export function getHolderDistributionOracle(): HolderDistributionOracle {
  if (!oracleSingleton) oracleSingleton = new HolderDistributionOracle();
  return oracleSingleton;
}
