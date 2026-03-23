/**
 * Centralise les timeouts HTTP (cold path) — merge avec signal utilisateur si présent.
 */

export function envHttpTimeoutMs(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function combineAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([a, b]);
  }
  const c = new AbortController();
  const fire = () => {
    try {
      c.abort();
    } catch {
      /* cold path */
    }
  };
  if (a.aborted || b.aborted) {
    fire();
    return c.signal;
  }
  a.addEventListener('abort', fire, { once: true });
  b.addEventListener('abort', fire, { once: true });
  return c.signal;
}

/**
 * `fetch` avec `AbortSignal.timeout` ; si `init.signal` est fourni, les deux déclenchent l'abort.
 */
export function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const ms = Math.max(1, timeoutMs);
  const timeoutSig = AbortSignal.timeout(ms);
  const userSig = init?.signal;
  const signal =
    userSig && !userSig.aborted
      ? combineAbortSignals(userSig, timeoutSig)
      : timeoutSig;
  return fetch(input, { ...init, signal });
}

export function defaultDexScreenerTimeoutMs(): number {
  return envHttpTimeoutMs('HTTP_DEX_SCREENER_TIMEOUT_MS', 5_000);
}

export function defaultHttpTimeoutMs(): number {
  return envHttpTimeoutMs('HTTP_FETCH_TIMEOUT_MS', 15_000);
}

export function defaultJitoHttpTimeoutMs(): number {
  return envHttpTimeoutMs('HTTP_JITO_TIMEOUT_MS', 5_000);
}

export function defaultJupiterUltraTimeoutMs(kind: 'order' | 'execute' | 'shield'): number {
  if (kind === 'execute') {
    return envHttpTimeoutMs('HTTP_JUPITER_ULTRA_EXECUTE_MS', 10_000);
  }
  if (kind === 'shield') {
    return envHttpTimeoutMs('HTTP_JUPITER_ULTRA_SHIELD_MS', 3_000);
  }
  return envHttpTimeoutMs('HTTP_JUPITER_ULTRA_ORDER_MS', 5_000);
}
