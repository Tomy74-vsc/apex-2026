/**
 * Nom / symbole affichés pour un mint Solana via DexScreener (gratuit, ~1 RPC HTTP).
 * Utilisé pour NarrativeRadar + métadonnées courbe Pump.fun (remplace le placeholder PUMP/Pump Token).
 */

import { defaultDexScreenerTimeoutMs, fetchWithTimeout } from '../infra/fetchWithTimeout.js';

const DEX_TOKEN_URL = 'https://api.dexscreener.com/latest/dex/tokens';

export async function fetchDexSolanaTokenMeta(
  mint: string,
): Promise<{ name: string; symbol: string } | null> {
  try {
    const resp = await fetchWithTimeout(
      `${DEX_TOKEN_URL}/${mint}`,
      {},
      defaultDexScreenerTimeoutMs(),
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      pairs?: Array<{ chainId?: string; baseToken?: { name?: string; symbol?: string } }>;
    };
    const sol = (data.pairs ?? []).filter((p) => p.chainId === 'solana');
    if (sol.length === 0) return null;
    const bt = sol.reduce(
      (best, p) =>
        (p.baseToken?.name?.length ?? 0) > (best.baseToken?.name?.length ?? 0) ? p : best,
      sol[0]!,
    ).baseToken;
    const name = (bt?.name ?? '').trim();
    const symbol = (bt?.symbol ?? '').trim();
    if (!name && !symbol) return null;
    return {
      name: name || 'Unknown',
      symbol: (symbol || 'PUMP').slice(0, 20),
    };
  } catch {
    return null;
  }
}
