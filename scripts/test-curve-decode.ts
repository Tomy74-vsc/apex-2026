import { Connection, PublicKey } from '@solana/web3.js';
import { KOTH_SOL_THRESHOLD, PUMP_PROGRAM_ID } from '../src/constants/pumpfun.js';
import {
  decodeBondingCurve,
  deriveBondingCurvePDA,
  type BondingCurveState,
} from '../src/types/bonding-curve.js';
import {
  calcProgress,
  calcPricePerToken,
  calcMarketCapSOL,
  calcBuyOutput,
  calcExpectedReturnOnGraduation,
  calcPriceImpact,
} from '../src/math/curve-math.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════════

const RPC_URL =
  process.env.HELIUS_RPC_URL ??
  process.env.RPC_URL ??
  'https://api.mainnet-beta.solana.com';

const connection = new Connection(RPC_URL, 'confirmed');
const isWatch = process.argv.includes('--watch');
const WATCH_INTERVAL_MS = 3_000;
const BENCH_ITERATIONS = 10_000;
const LAMPORTS_PER_SOL = 1_000_000_000;

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function fmt(n: number, decimals = 4): string {
  return n.toFixed(decimals);
}

function fmtBig(n: bigint): string {
  return n.toLocaleString('en-US');
}

function solFromLamports(lamports: bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

function displayState(
  mint: string,
  pda: PublicKey,
  state: BondingCurveState,
  rawData: Buffer,
): void {
  const progress = calcProgress(state.realTokenReserves);
  const price = calcPricePerToken(state.virtualSolReserves, state.virtualTokenReserves);
  const mcap = calcMarketCapSOL(state.virtualSolReserves, state.virtualTokenReserves);
  const realSol = solFromLamports(state.realSolReserves);
  const isKOTH = realSol >= KOTH_SOL_THRESHOLD;
  const expectedReturn = calcExpectedReturnOnGraduation(state.realSolReserves);

  console.log('');
  console.log('📊 ═══════════════════════════════════════════════════════════');
  console.log(`📊  Bonding Curve State`);
  console.log('📊 ═══════════════════════════════════════════════════════════');
  console.log(`  🎯 Mint              : ${mint}`);
  console.log(`  🎯 Bonding Curve PDA : ${pda.toBase58()}`);
  console.log(`  ─────────────────────────────────────────────────`);
  console.log(`  📊 Virtual Token     : ${fmtBig(state.virtualTokenReserves)}`);
  console.log(`  📊 Virtual SOL       : ${fmtBig(state.virtualSolReserves)} (${fmt(solFromLamports(state.virtualSolReserves), 2)} SOL)`);
  console.log(`  📊 Real Token        : ${fmtBig(state.realTokenReserves)}`);
  console.log(`  📊 Real SOL          : ${fmtBig(state.realSolReserves)} (${fmt(realSol, 4)} SOL)`);
  console.log(`  ─────────────────────────────────────────────────`);
  console.log(`  📊 Progress          : ${fmt(progress * 100, 1)}%`);
  console.log(`  💰 Prix actuel       : ${price.toExponential(6)} SOL/raw unit`);
  console.log(`  💰 Market Cap        : ${fmt(mcap, 2)} SOL`);
  console.log(`  🏆 Completed         : ${state.complete}`);
  console.log(`  👤 Creator           : ${state.creator.toBase58()}`);
  console.log(`  🔥 KOTH (>= 32 SOL) : ${isKOTH}`);
  console.log(`  🎲 Mayhem Mode       : ${state.isMayhemMode}`);

  if (!state.complete) {
    console.log(`  ─────────────────────────────────────────────────`);
    console.log(`  🎯 Expected return   : ${fmt(expectedReturn, 4)}x at graduation`);

    const simSol = BigInt(LAMPORTS_PER_SOL / 10); // 0.1 SOL
    const tokensOut = calcBuyOutput(
      state.virtualSolReserves,
      state.virtualTokenReserves,
      simSol,
    );
    const impact = calcPriceImpact(
      state.virtualSolReserves,
      state.virtualTokenReserves,
      simSol,
    );
    console.log(`  🛒 Buy 0.1 SOL      : ${fmtBig(tokensOut)} tokens`);
    console.log(`  📉 Price impact      : ${fmt(impact * 100, 4)}%`);
  }

  // Benchmark
  const t0 = performance.now();
  for (let i = 0; i < BENCH_ITERATIONS; i++) {
    decodeBondingCurve(rawData);
  }
  const elapsed = performance.now() - t0;
  const perDecode = (elapsed / BENCH_ITERATIONS) * 1_000; // ns
  console.log(`  ─────────────────────────────────────────────────`);
  console.log(`  ⏱️  Decode bench      : ${fmt(perDecode, 0)}ns / decode (${BENCH_ITERATIONS} iter, ${fmt(elapsed, 2)}ms total)`);
  console.log('📊 ═══════════════════════════════════════════════════════════');
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Find a recent Pump.fun token if no mint provided
// ═══════════════════════════════════════════════════════════════════════════════

async function findRecentPumpToken(): Promise<string | null> {
  console.log('🔍 Aucun mint fourni — recherche d\'un token Pump.fun recent...');
  try {
    const sigs = await connection.getSignaturesForAddress(
      PUMP_PROGRAM_ID,
      { limit: 20 },
      'confirmed',
    );

    for (const sig of sigs) {
      try {
        const tx = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx?.meta?.postTokenBalances) continue;

        for (const bal of tx.meta.postTokenBalances) {
          if (!bal.mint) continue;
          const mintPk = new PublicKey(bal.mint);
          const [pda] = deriveBondingCurvePDA(mintPk);
          const info = await connection.getAccountInfo(pda, 'confirmed');
          if (info && info.data.length >= 90) {
            console.log(`✅ Token Pump.fun trouve: ${bal.mint}`);
            return bal.mint;
          }
        }
      } catch {
        continue;
      }
    }
  } catch (err) {
    console.error('⚠️ Erreur recherche token:', err instanceof Error ? err.message : err);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Fetch & decode
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchAndDecode(mint: string): Promise<{
  state: BondingCurveState;
  pda: PublicKey;
  rawData: Buffer;
} | null> {
  const mintPk = new PublicKey(mint);
  const [pda] = deriveBondingCurvePDA(mintPk);

  const t0 = performance.now();
  const info = await connection.getAccountInfo(pda, 'confirmed');
  const rpcMs = (performance.now() - t0).toFixed(1);

  if (!info) {
    console.error(`❌ Compte ${pda.toBase58()} introuvable (pas une bonding curve Pump.fun?)`);
    return null;
  }

  console.log(`⚡ RPC getAccountInfo: ${rpcMs}ms (${info.data.length} bytes)`);

  const rawData = Buffer.from(info.data);
  const state = decodeBondingCurve(rawData);
  return { state, pda, rawData };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Watch mode
// ═══════════════════════════════════════════════════════════════════════════════

async function watchLoop(mint: string): Promise<void> {
  console.log(`👁️  Mode watch — poll toutes les ${WATCH_INTERVAL_MS / 1000}s (Ctrl+C pour stop)`);
  let prevProgress = -1;

  const poll = async () => {
    try {
      const result = await fetchAndDecode(mint);
      if (!result) return;

      const progress = calcProgress(result.state.realTokenReserves);
      const realSol = solFromLamports(result.state.realSolReserves);
      const mcap = calcMarketCapSOL(result.state.virtualSolReserves, result.state.virtualTokenReserves);

      if (prevProgress !== progress) {
        const delta = prevProgress >= 0 ? ` (Δ ${fmt((progress - prevProgress) * 100, 2)}%)` : '';
        console.log(
          `[${new Date().toLocaleTimeString()}] ` +
          `Progress: ${fmt(progress * 100, 2)}%${delta} | ` +
          `SOL: ${fmt(realSol, 4)} | ` +
          `MCap: ${fmt(mcap, 1)} SOL | ` +
          `Complete: ${result.state.complete}`,
        );
        prevProgress = progress;
      }

      if (result.state.complete) {
        console.log('🎓 TOKEN GRADUATED — arret du watch');
        return;
      }
    } catch (err) {
      console.error('⚠️ Poll error:', err instanceof Error ? err.message : err);
    }
    setTimeout(poll, WATCH_INTERVAL_MS);
  };

  await poll();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('🚀 APEX-2026 — Bonding Curve Decoder Test');
  console.log(`🔗 RPC: ${RPC_URL.replace(/api-key=[^&]+/, 'api-key=***')}`);
  console.log('');

  let mint = process.argv.find((a) => !a.startsWith('-') && a.length >= 32 && a.length <= 44);

  if (!mint) {
    mint = (await findRecentPumpToken()) ?? undefined;
    if (!mint) {
      console.error('❌ Aucun token Pump.fun trouve. Usage: bun scripts/test-curve-decode.ts <MINT>');
      process.exit(1);
    }
  }

  const result = await fetchAndDecode(mint);
  if (!result) process.exit(1);

  displayState(mint, result.pda, result.state, result.rawData);

  if (isWatch && !result.state.complete) {
    await watchLoop(mint);
  }
}

main().catch((err) => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
