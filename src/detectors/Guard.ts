import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getMint, getAccount, TokenAccountNotFoundError, TokenInvalidAccountOwnerError } from '@solana/spl-token';
import { createJupiterApiClient, type QuoteResponse, type SwapResponse } from '@jup-ag/api';
import type { SecurityReport } from '../types/index.js';
import type { TrackedCurve } from '../types/bonding-curve.js';
import {
  readCurveEntryMaxProgress,
  readCurveEntryMinProgress,
} from '../constants/curve-entry-bands.js';
import { defaultDexScreenerTimeoutMs, fetchWithTimeout } from '../infra/fetchWithTimeout.js';

export interface CurveGuardResult {
  allowed: boolean;
  flags: string[];
}


// SOL mint address
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Raydium AMM v4 Program ID
const RAYDIUM_AMM_V4_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

// Adresses de burn communes
const BURN_ADDRESSES = [
  '11111111111111111111111111111111', // System Program (burn)
  '1nc1nerator11111111111111111111111111111111', // Incinerator
];

type GuardStats = {
  totalChecks: number;
  // EWMA latence totale parallèle (ms)
  avgParallelLatencyMs: number;
  // EWMA somme des latences individuelles (ms) — ce que ça aurait pris en série
  avgSerialLatencyMs: number;
  // Gain réel = avgSerialLatencyMs / avgParallelLatencyMs
  // Ex: 3.2 = le parallèle est 3.2× plus rapide que le série
  parallelGain: number;
};

const guardStatsInternal: GuardStats = {
  totalChecks: 0,
  avgParallelLatencyMs: 0,
  avgSerialLatencyMs: 0,
  parallelGain: 1,
};

const EWMA_ALPHA = 0.1;

/**
 * Guard - Analyseur de sécurité on-chain pour tokens Solana
 * 
 * Vérifie les autorités (Mint/Freeze), détecte les honeypots via simulation,
 * calcule un riskScore basé sur la concentration des holders et la liquidité.
 */
export class Guard {
  private jupiterApi: ReturnType<typeof createJupiterApiClient>;
  private rpcEndpoints: string[];

  constructor(rpcUrl?: string) {
    const envRpcs = [
      rpcUrl,
      process.env.HELIUS_RPC_URL,
      process.env.QUICKNODE_RPC_URL,
      process.env.BACKUP_RPC_URL,
      process.env.RPC_URL,
    ].filter((v): v is string => !!v);

    if (envRpcs.length === 0) {
      throw new Error('HELIUS_RPC_URL, QUICKNODE_RPC_URL, BACKUP_RPC_URL ou RPC_URL doit être défini dans .env');
    }

    this.rpcEndpoints = Array.from(new Set(envRpcs));

    // Initialise l'API Jupiter
    this.jupiterApi = createJupiterApiClient();
  }

  /**
   * Valide un token en vérifiant les autorités mint/freeze via Account Info
   * 
   * @param mint - Adresse du mint token
   * @returns SecurityReport avec validation des autorités
   */
  async validateToken(mint: string): Promise<SecurityReport> {
    return this.analyzeToken(mint);
  }

  /**
   * Analyse complète d'un token pour générer un SecurityReport
   * 
   * @param mint - Adresse publique du mint token
   * @returns SecurityReport avec riskScore et flags de sécurité
   */
  async analyzeToken(mint: string): Promise<SecurityReport> {
    const startedAt = performance.now();
    const mintPubkey = new PublicKey(mint);
    const flags: string[] = [];
    let riskScore = 0;
    const mintShort = mint.slice(0, 8);

    const wrapWithTiming = async <T>(
      p: Promise<T>,
    ): Promise<{ result: PromiseSettledResult<T>; ms: number }> => {
      const t0 = performance.now();
      try {
        const value = await p;
        return {
          result: { status: 'fulfilled', value } as PromiseFulfilledResult<T>,
          ms: performance.now() - t0,
        };
      } catch (reason) {
        return {
          result: { status: 'rejected', reason } as PromiseRejectedResult,
          ms: performance.now() - t0,
        };
      }
    };

    const wrappedResults = await Promise.allSettled([
      wrapWithTiming(this.safeGetMint(mintPubkey)),
      wrapWithTiming(this.calculateTop10HoldersPercent(mintPubkey)),
      wrapWithTiming(this.detectHoneypot(mintPubkey)),
      wrapWithTiming(this.checkRaydiumLiquidity(mintPubkey)),
      wrapWithTiming(this.calculateLPBurnedPercent(mintPubkey)),
    ]).then((results) =>
      results.map((r) =>
        r.status === 'fulfilled'
          ? r.value
          : { result: { status: 'rejected' as const, reason: (r as PromiseRejectedResult).reason }, ms: 0 },
      ),
    );

    const FALLBACK_WRAPPED = {
      result: { status: 'rejected' as const, reason: 'missing' },
      ms: 0,
    };
    const mintWrapped = (wrappedResults[0] ?? FALLBACK_WRAPPED) as {
      result: PromiseSettledResult<Awaited<ReturnType<Guard['safeGetMint']>>>;
      ms: number;
    };
    const top10Wrapped = (wrappedResults[1] ?? FALLBACK_WRAPPED) as {
      result: PromiseSettledResult<number>;
      ms: number;
    };
    const honeypotWrapped = (wrappedResults[2] ?? FALLBACK_WRAPPED) as {
      result: PromiseSettledResult<boolean>;
      ms: number;
    };
    const liquidityWrapped = (wrappedResults[3] ?? FALLBACK_WRAPPED) as {
      result: PromiseSettledResult<{ hasLiquidity: boolean; liquiditySol?: number }>;
      ms: number;
    };
    const lpBurnedWrapped = (wrappedResults[4] ?? FALLBACK_WRAPPED) as {
      result: PromiseSettledResult<number>;
      ms: number;
    };

    const mintInfoResult = mintWrapped.result;
    const top10Result = top10Wrapped.result;
    const honeypotResult = honeypotWrapped.result;
    const liquidityResult = liquidityWrapped.result;
    const lpBurnedResult = lpBurnedWrapped.result;

    let mintRenounced = false;
    let freezeDisabled = false;
    let lpBurnedPercent = 0;
    let top10HoldersPercent = 0;
    let isHoneypot = true;
    let liquidityInfo: { hasLiquidity: boolean; liquiditySol?: number } = { hasLiquidity: false };

    if (mintInfoResult.status === 'fulfilled' && mintInfoResult.value) {
      const mintInfo = mintInfoResult.value;
      mintRenounced = mintInfo.mintAuthority === null;
      freezeDisabled = mintInfo.freezeAuthority === null;

      if (!mintRenounced) {
        flags.push('MINT_AUTHORITY_NOT_RENOUNCED');
      }
      if (!freezeDisabled) {
        flags.push('FREEZE_AUTHORITY_NOT_DISABLED');
        riskScore += 50;
      }
    } else {
      flags.push('MINT_INFO_UNAVAILABLE');
      riskScore += 30;
    }

    if (top10Result.status === 'fulfilled') {
      top10HoldersPercent = top10Result.value;
      if (top10HoldersPercent > 50) {
        flags.push('HIGH_CONCENTRATION');
        riskScore += 30;
      }
    } else {
      flags.push('TOP10_HOLDERS_CHECK_FAILED');
      riskScore += 10;
    }

    if (honeypotResult.status === 'fulfilled') {
      isHoneypot = honeypotResult.value;
      if (isHoneypot) {
        flags.push('HONEYPOT_DETECTED');
        riskScore += 100;
      }
    } else {
      flags.push('HONEYPOT_CHECK_FAILED');
      riskScore += 40;
      isHoneypot = true;
    }

    if (liquidityResult.status === 'fulfilled') {
      liquidityInfo = liquidityResult.value;
      if (!liquidityInfo.hasLiquidity) {
        flags.push('NO_LIQUIDITY_POOL');
        riskScore += 40;
      } else if (liquidityInfo.liquiditySol !== undefined && liquidityInfo.liquiditySol < 5) {
        flags.push('LOW_LIQUIDITY');
        riskScore += 20;
      }
    } else {
      flags.push('LIQUIDITY_CHECK_FAILED');
      riskScore += 20;
    }

    if (lpBurnedResult.status === 'fulfilled') {
      lpBurnedPercent = lpBurnedResult.value;
    } else {
      flags.push('LP_BURN_CHECK_FAILED');
      lpBurnedPercent = 0;
    }

    const isSafe =
      riskScore < 50 &&
      !isHoneypot &&
      mintRenounced &&
      freezeDisabled &&
      liquidityInfo.hasLiquidity === true;

    const parallelLatencyMs = performance.now() - startedAt;
    const serialLatencyMs =
      mintWrapped.ms +
      top10Wrapped.ms +
      honeypotWrapped.ms +
      liquidityWrapped.ms +
      lpBurnedWrapped.ms;
    const checksCount = 5;

    if (guardStatsInternal.totalChecks === 0) {
      guardStatsInternal.avgParallelLatencyMs = parallelLatencyMs;
      guardStatsInternal.avgSerialLatencyMs = serialLatencyMs;
    } else {
      guardStatsInternal.avgParallelLatencyMs =
        EWMA_ALPHA * parallelLatencyMs +
        (1 - EWMA_ALPHA) * guardStatsInternal.avgParallelLatencyMs;
      guardStatsInternal.avgSerialLatencyMs =
        EWMA_ALPHA * serialLatencyMs +
        (1 - EWMA_ALPHA) * guardStatsInternal.avgSerialLatencyMs;
    }

    guardStatsInternal.totalChecks += 1;
    guardStatsInternal.parallelGain =
      guardStatsInternal.avgSerialLatencyMs /
      Math.max(1, guardStatsInternal.avgParallelLatencyMs);

    const statusEmoji = isSafe ? '✅' : '❌';
    const gainDisplay = guardStatsInternal.parallelGain.toFixed(1);
    console.log(
      `${statusEmoji} Guard [${mintShort}] ${isSafe ? 'ok' : 'risk'} en ${parallelLatencyMs.toFixed(
        0,
      )}ms | checks: ${checksCount} parallel | serial_eq: ${serialLatencyMs.toFixed(
        0,
      )}ms | gain: ${gainDisplay}×`,
    );

    return {
      mint,
      isSafe,
      riskScore: Math.min(riskScore, 100), // Cap à 100
      flags,
      details: {
        mintRenounced,
        freezeDisabled,
        lpBurnedPercent,
        top10HoldersPercent,
        isHoneypot,
        liquiditySol: liquidityInfo.liquiditySol,
        hasLiquidity: liquidityInfo.hasLiquidity,
      },
    };
  }

  /**
   * Course RPC sur tous les endpoints disponibles et retourne le premier résultat.
   */
  private async rpcRace<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    const connections = this.rpcEndpoints.map(
      (url) =>
        new Connection(url, {
          commitment: 'confirmed',
          confirmTransactionInitialTimeout: 30000,
        }),
    );

    const tasks = connections.map((conn) => fn(conn));

    try {
      return await Promise.any(tasks);
    } catch (error) {
      const agg = error as AggregateError;
      console.error(
        '❌ [Guard] rpcRace failed across all endpoints:',
        agg.errors ?? agg,
      );
      throw error;
    }
  }

  /**
   * getMint avec rpcRace et gestion d'erreur silencieuse.
   */
  private async safeGetMint(mintPubkey: PublicKey) {
    try {
      const t0 = performance.now();
      const mintInfo = await this.rpcRace((conn) => getMint(conn, mintPubkey));
      const ms = (performance.now() - t0).toFixed(2);
      console.log(`🛡️ [Guard] Mint info: ${ms}ms`);
      return mintInfo;
    } catch (error) {
      console.warn('⚠️ [Guard] safeGetMint failed:', error);
      return null;
    }
  }

  /**
   * Calcule le pourcentage détenu par les top 10 holders
   * 
   * @param mintPubkey - PublicKey du mint
   * @returns Pourcentage (0-100) détenu par les top 10 holders
   */
  private async calculateTop10HoldersPercent(mintPubkey: PublicKey): Promise<number> {
    const t0 = performance.now();
    try {
      const largestAccounts = await this.rpcRace((conn) =>
        conn.getTokenLargestAccounts(mintPubkey),
      );

      if (!largestAccounts.value || largestAccounts.value.length === 0) {
        return 0;
      }

      const balances: bigint[] = largestAccounts.value
        .map((acc) => {
          try {
            return BigInt(acc.amount);
          } catch {
            return 0n;
          }
        })
        .filter((b) => b > 0n);

      if (balances.length === 0) {
        return 0;
      }

      balances.sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
      const top10 = balances.slice(0, 10);

      const mintInfo = await this.safeGetMint(mintPubkey);
      if (!mintInfo || mintInfo.supply === 0n) {
        return 0;
      }

      const top10Sum = top10.reduce((acc, b) => acc + b, 0n);
      const percent = Number((top10Sum * 10000n) / mintInfo.supply) / 100;

      const ms = (performance.now() - t0).toFixed(2);
      console.log(
        `🛡️ [Guard] Top10 analysis: ${ms}ms (${balances.length} holders, source=getTokenLargestAccounts)`,
      );

      return Math.min(percent, 100);
    } catch (error) {
      const ms = (performance.now() - t0).toFixed(2);
      console.error(
        `❌ [Guard] calculateTop10 failed (${ms}ms): ${
          error instanceof Error ? error.message : error
        }`,
      );
      return 0;
    }
  }

  /**
   * Détecte les honeypots en simulant une transaction de swap via Jupiter
   * 
   * Un honeypot est détecté si :
   * - Aucune route de swap n'est disponible
   * - La simulation de transaction échoue
   * - Le swap retourne 0 tokens (impossible de vendre)
   * 
   * @param mintPubkey - PublicKey du mint
   * @returns true si honeypot détecté (swap échoue en simulation)
   */
  private async detectHoneypot(mintPubkey: PublicKey): Promise<boolean> {
    const t0Honeypot = performance.now();
    try {
      const inputMint = SOL_MINT; // On achète avec SOL
      const outputMint = mintPubkey.toBase58();
      const amount = 1000000; // 0.001 SOL (1M lamports)

      // 1. Vérifie si une route de swap existe
      let quote: QuoteResponse;
      try {
        const quotePromise = this.jupiterApi.quoteGet({
          inputMint,
          outputMint,
          amount,
          slippageBps: 50, // 0.5% slippage
        });
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Jupiter timeout')), 5000),
        );
        quote = (await Promise.race([quotePromise, timeout])) as QuoteResponse;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('timeout')) {
          console.warn('⚠️ [Guard] Jupiter quote timeout — assuming not honeypot');
          console.log(
            `🛡️ [Guard] Honeypot check: ${(performance.now() - t0Honeypot).toFixed(2)}ms`,
          );
          return false; // timeout ≠ honeypot, on laisse passer
        }
        // Pas de route disponible = probable honeypot
        console.log(
          `🛡️ [Guard] Honeypot check: ${(performance.now() - t0Honeypot).toFixed(2)}ms`,
        );
        return true;
      }

      // 2. Si la quote retourne 0 output, c'est un honeypot
      if (!quote.outAmount || quote.outAmount === '0') {
        console.log(
          `🛡️ [Guard] Honeypot check: ${(performance.now() - t0Honeypot).toFixed(2)}ms`,
        );
        return true;
      }

      // 3. Essaie de créer une transaction de swap
      // Note: Pour une vraie simulation, il faudrait un wallet signer
      // On simule juste la création de la transaction
      try {
        // Utilise une clé publique valide pour la simulation (peut être n'importe quelle clé)
        const dummyPublicKey = new PublicKey('11111111111111111111111111111111');
        const swapResponse: SwapResponse = await this.jupiterApi.swapPost({
          swapRequest: {
            quoteResponse: quote,
            userPublicKey: dummyPublicKey.toBase58(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
          },
        });

        if (!swapResponse.swapTransaction) {
          console.log(
            `🛡️ [Guard] Honeypot check: ${(performance.now() - t0Honeypot).toFixed(2)}ms`,
          );
          return true; // Pas de transaction possible = honeypot
        }

        // 4. Simule la transaction
        const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

        const simulation = await this.rpcRace((conn) =>
          conn.simulateTransaction(transaction, {
            replaceRecentBlockhash: true,
            sigVerify: false,
          }),
        );

        // Si la simulation échoue, c'est probablement un honeypot
        if (simulation.value.err) {
          console.log(
            `🛡️ [Guard] Honeypot check: ${(performance.now() - t0Honeypot).toFixed(2)}ms`,
          );
          return true;
        }

        // Si le log contient des erreurs de transfert, c'est un honeypot
        const logs = simulation.value.logs || [];
        const hasTransferError = logs.some(
          (log) =>
            log.includes('insufficient funds') ||
            log.includes('transfer failed') ||
            log.includes('invalid account') ||
            log.includes('unauthorized')
        );

        console.log(
          `🛡️ [Guard] Honeypot check: ${(performance.now() - t0Honeypot).toFixed(2)}ms`,
        );
        return hasTransferError;
      } catch (error) {
        // Erreur lors de la création/simulation = probable honeypot
        console.log(
          `🛡️ [Guard] Honeypot check: ${(performance.now() - t0Honeypot).toFixed(2)}ms`,
        );
        return true;
      }
    } catch (error) {
      // Si la simulation échoue complètement, on considère que c'est un honeypot
      console.warn('Erreur lors de la simulation de swap:', error);
      console.log(
        `🛡️ [Guard] Honeypot check: ${(performance.now() - t0Honeypot).toFixed(2)}ms`,
      );
      return true;
    }
  }

  /**
   * Vérifie la liquidité sur Raydium AMM v4
   * 
  * Utilise DexScreener pour estimer l'existence d'un pool et la liquidité.
   */
  private async checkRaydiumLiquidity(mintPubkey: PublicKey): Promise<{
    hasLiquidity: boolean;
    liquiditySol?: number;
  }> {
    try {
      const mint = mintPubkey.toBase58();
      const t0Liq = performance.now();

      const resp = await fetchWithTimeout(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        {},
        defaultDexScreenerTimeoutMs(),
      );

      if (!resp.ok) {
        console.log(
          `🛡️ [Guard] Liquidity check: ${(performance.now() - t0Liq).toFixed(2)}ms`,
        );
        return { hasLiquidity: false };
      }

      const data = (await resp.json()) as {
        pairs?: Array<{
          chainId?: string;
          liquidity?: { usd?: number };
        }>;
      };

      const pairs = data.pairs ?? [];
      const solanaPairs = pairs.filter((p) => p.chainId === 'solana');

      if (solanaPairs.length === 0) {
        console.log(
          `🛡️ [Guard] Liquidity check: ${(performance.now() - t0Liq).toFixed(2)}ms`,
        );
        return { hasLiquidity: false };
      }

      const bestPair = solanaPairs.reduce((best, p) =>
        (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best,
      );

      const liquidityUsd = bestPair.liquidity?.usd ?? 0;
      const SOL_PRICE_USD = 150;
      const liquiditySol = liquidityUsd / SOL_PRICE_USD;

      console.log(
        `🛡️ [Guard] Liquidity check: ${(performance.now() - t0Liq).toFixed(2)}ms`,
      );

      if (liquiditySol <= 0) {
        return { hasLiquidity: false };
      }

      return {
        hasLiquidity: true,
        liquiditySol,
      };
    } catch (error) {
      console.error('Erreur lors de la vérification de liquidité Raydium:', error);
      const t0Liq = performance.now();
      console.log(
        `🛡️ [Guard] Liquidity check: ${(performance.now() - t0Liq).toFixed(2)}ms`,
      );
      return { hasLiquidity: false };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V3.1 Curve-Specific Guards
  // ═══════════════════════════════════════════════════════════════════════════

  validateCurve(
    curve: TrackedCurve,
    activePositions: number,
  ): CurveGuardResult {
    const flags: string[] = [];
    const minProgress = readCurveEntryMinProgress();
    const maxProgress = readCurveEntryMaxProgress();
    const maxPositions = parseInt(process.env.MAX_CONCURRENT_CURVE_POSITIONS ?? '5');

    if (curve.state.complete) {
      flags.push('CURVE_COMPLETE');
    }

    if (curve.progress < minProgress) {
      flags.push(`PROGRESS_TOO_LOW:${(curve.progress * 100).toFixed(1)}%<${(minProgress * 100).toFixed(0)}%`);
    }

    if (curve.progress > maxProgress) {
      flags.push(`PROGRESS_TOO_HIGH:${(curve.progress * 100).toFixed(1)}%>${(maxProgress * 100).toFixed(0)}%`);
    }

    if (activePositions >= maxPositions) {
      flags.push(`MAX_POSITIONS:${activePositions}>=${maxPositions}`);
    }

    const ageMs = Date.now() - curve.createdAt;
    const maxHoldMs = parseInt(process.env.MAX_HOLD_TIME_MINUTES ?? '120') * 60_000;
    if (ageMs > maxHoldMs) {
      flags.push(`CURVE_TOO_OLD:${Math.round(ageMs / 60_000)}min`);
    }

    const allowed = flags.length === 0;

    if (!allowed) {
      console.log(`🛡️ [Guard:Curve] ${curve.mint.slice(0, 8)} BLOCKED: ${flags.join(', ')}`);
    }

    return { allowed, flags };
  }

  /**
   * Courbe : garde synchrone puis, en live + CURVE_FULL_GUARD=1, `analyzeToken` avec timeout.
   * Paper / flag off : équivalent `validateCurve` uniquement (pas de latence Jupiter/Raydium).
   */
  async validateCurveForExecution(
    curve: TrackedCurve,
    activePositions: number,
  ): Promise<CurveGuardResult> {
    const sync = this.validateCurve(curve, activePositions);
    if (!sync.allowed) {
      return sync;
    }

    const full = (process.env.CURVE_FULL_GUARD ?? '').trim() === '1';
    const live =
      (process.env.TRADING_MODE ?? '').trim() === 'live' &&
      (process.env.TRADING_ENABLED ?? '').trim() === 'true';
    if (!full || !live) {
      return sync;
    }

    const timeoutMs = parseInt(process.env.CURVE_GUARD_TOKEN_TIMEOUT_MS ?? '12000', 10) || 12_000;
    const maxRisk = parseInt(process.env.MAX_RISK_SCORE ?? '50', 10) || 50;
    const mint = curve.mint;

    try {
      const security = await Promise.race([
        this.analyzeToken(mint),
        new Promise<SecurityReport>((_, rej) => {
          setTimeout(() => rej(new Error('CURVE_GUARD_TOKEN_TIMEOUT')), timeoutMs);
        }),
      ]);

      if (!security.isSafe || security.riskScore > maxRisk) {
        const flags = [
          ...sync.flags,
          `TOKEN_ANALYSIS:unsafe_or_risk`,
          `riskScore=${security.riskScore}`,
          ...security.flags.map((f) => `tok:${f}`),
        ];
        console.log(`🛡️ [Guard:Curve+Token] ${mint.slice(0, 8)} BLOCKED after full token check`);
        return { allowed: false, flags };
      }

      return sync;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`⚠️  [Guard:Curve+Token] ${mint.slice(0, 8)} ${msg.slice(0, 80)}`);
      return {
        allowed: false,
        flags: [...sync.flags, `TOKEN_GUARD_FAIL:${msg.slice(0, 60)}`],
      };
    }
  }

  /**
   * Calcule le pourcentage de LP brûlé
   * 
   * Vérifie si les LP tokens sont dans une adresse de burn.
   * 
   * @param mintPubkey - PublicKey du mint
   * @returns Pourcentage de LP brûlé (approximation)
   */
  private async calculateLPBurnedPercent(mintPubkey: PublicKey): Promise<number> {
    try {
      const t0LP = performance.now();
      const lpPromise = async (): Promise<number> => {
        const pools = await this.rpcRace((conn) =>
          conn.getProgramAccounts(RAYDIUM_AMM_V4_PROGRAM_ID, {
            filters: [
              {
                dataSize: 752,
              },
            ],
          }),
        );

        for (const pool of pools) {
          try {
            const data = pool.account.data;
            const baseMint = new PublicKey(data.slice(400, 432));
            const quoteMint = new PublicKey(data.slice(432, 464));

            const solMintPubkey = new PublicKey(SOL_MINT);
            const isMatchingPool = 
              (baseMint.equals(mintPubkey) && quoteMint.equals(solMintPubkey)) ||
              (baseMint.equals(solMintPubkey) && quoteMint.equals(mintPubkey));

            if (isMatchingPool) {
              // Offset 528: lpMint (32 bytes)
              const lpMint = new PublicKey(data.slice(528, 560));

              const lpMintInfo = await this.rpcRace((conn) => getMint(conn, lpMint));
              const totalSupply = lpMintInfo.supply;

              if (totalSupply === 0n) {
                console.log(
                  `🛡️ [Guard] LP burn check: ${(performance.now() - t0LP).toFixed(2)}ms`,
                );
                return 100; // Tout est brûlé
              }

              // Vérifie combien de LP tokens sont dans les adresses de burn
              let burnedAmount = 0n;

              for (const burnAddress of BURN_ADDRESSES) {
                try {
                  const burnPubkey = new PublicKey(burnAddress);
                  const tokenAccounts = await this.rpcRace((conn) =>
                    conn.getTokenAccountsByOwner(burnPubkey, {
                      mint: lpMint,
                    }),
                  );

                    for (const account of tokenAccounts.value) {
                      const tokenAccount = await this.rpcRace((conn) =>
                        getAccount(conn, account.pubkey),
                      );
                      burnedAmount += tokenAccount.amount;
                    }
                } catch {
                  // Ignore si l'adresse n'a pas de token account
                  continue;
                }
              }

              console.log(
                `🛡️ [Guard] LP burn check: ${(performance.now() - t0LP).toFixed(2)}ms`,
              );
              return Number((burnedAmount * 100n) / totalSupply);
            }
          } catch {
            continue;
          }
        }

        console.log(
          `🛡️ [Guard] LP burn check: ${(performance.now() - t0LP).toFixed(2)}ms`,
        );
        return 0; // Pool non trouvé
      };

      const timeout = new Promise<number>((resolve) =>
        setTimeout(() => {
          console.warn('⚠️ [Guard] LP burn check timeout — assuming 0% burned');
          console.log(
            `🛡️ [Guard] LP burn check: ${(performance.now() - t0LP).toFixed(2)}ms`,
          );
          resolve(0);
        }, 6000),
      );

      return Promise.race([lpPromise(), timeout]);
    } catch (error) {
      console.error('Erreur lors du calcul du LP burned:', error);
      const t0LP = performance.now();
      console.log(
        `🛡️ [Guard] LP burn check: ${(performance.now() - t0LP).toFixed(2)}ms`,
      );
      return 0;
    }
  }
}
