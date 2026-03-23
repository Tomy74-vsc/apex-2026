import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import {
  PUMP_PROGRAM_ID,
  GLOBAL_ACCOUNT,
  FEE_RECIPIENT,
  EVENT_AUTHORITY,
  BUY_DISCRIMINATOR,
  SELL_DISCRIMINATOR,
} from '../../constants/pumpfun.js';
import {
  deriveBondingCurvePDA,
  deriveAssociatedBondingCurve,
} from '../../types/bonding-curve.js';
import { calcBuyOutput, calcSellOutput } from '../../math/curve-math.js';
import { defaultJitoHttpTimeoutMs, fetchWithTimeout } from '../../infra/fetchWithTimeout.js';

const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bPg5BEfx7FkNYPgR3sTMjV',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSLZa6eiPIeYhp4Fij9',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

export interface CurveTradeResult {
  success: boolean;
  signature: string | null;
  solAmount: number;
  tokenAmount: bigint;
  error: string | null;
  latencyMs: number;
}

export class CurveExecutor {
  private readonly connection: Connection;
  private readonly payer: Keypair;
  private readonly isPaper: boolean;
  private readonly jitoBlockEngineUrl: string;
  private readonly defaultTipLamports: number;

  constructor() {
    const rpcUrl = process.env.HELIUS_RPC_URL ?? process.env.RPC_URL;
    if (!rpcUrl) throw new Error('CurveExecutor: HELIUS_RPC_URL required');
    this.connection = new Connection(rpcUrl, 'confirmed');

    const privKey = process.env.WALLET_PRIVATE_KEY;
    if (!privKey) throw new Error('CurveExecutor: WALLET_PRIVATE_KEY required');
    this.payer = Keypair.fromSecretKey(
      privKey.startsWith('[')
        ? Uint8Array.from(JSON.parse(privKey))
        : bs58.decode(privKey),
    );

    this.isPaper = (process.env.TRADING_MODE ?? 'paper') === 'paper';
    this.jitoBlockEngineUrl = process.env.JITO_BLOCK_ENGINE_URL ?? 'https://amsterdam.mainnet.block-engine.jito.wtf';
    this.defaultTipLamports = 50_000; // 0.00005 SOL
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUY
  // ═══════════════════════════════════════════════════════════════════════════

  async buy(
    mint: string,
    solAmount: number,
    slippageBps = 300,
    vSol?: bigint,
    vToken?: bigint,
  ): Promise<CurveTradeResult> {
    const t0 = performance.now();
    try {
      const mintPk = new PublicKey(mint);
      const [curvePDA] = deriveBondingCurvePDA(mintPk);
      const curveATA = deriveAssociatedBondingCurve(mintPk, curvePDA);
      const buyerATA = getAssociatedTokenAddressSync(mintPk, this.payer.publicKey);

      const solLamports = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));

      // Expected tokens (for slippage calc)
      let expectedTokens = 0n;
      if (vSol && vToken) {
        expectedTokens = calcBuyOutput(vSol, vToken, solLamports);
      }

      // maxSolCost = solAmount + slippage
      const maxSolCost = solLamports + (solLamports * BigInt(slippageBps)) / 10_000n;

      // Build buy instruction data: discriminator(8) + amount(8) + maxSolCost(8) = 24 bytes
      const data = Buffer.alloc(24);
      data.set(BUY_DISCRIMINATOR, 0);
      data.writeBigUInt64LE(expectedTokens > 0n ? expectedTokens : solLamports * 1_000n, 8);
      data.writeBigUInt64LE(maxSolCost, 16);

      const buyIx = new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: [
          { pubkey: GLOBAL_ACCOUNT,                 isSigner: false, isWritable: false },
          { pubkey: FEE_RECIPIENT,                  isSigner: false, isWritable: true },
          { pubkey: mintPk,                         isSigner: false, isWritable: false },
          { pubkey: curvePDA,                       isSigner: false, isWritable: true },
          { pubkey: curveATA,                       isSigner: false, isWritable: true },
          { pubkey: buyerATA,                       isSigner: false, isWritable: true },
          { pubkey: this.payer.publicKey,            isSigner: true,  isWritable: true },
          { pubkey: SystemProgram.programId,         isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID,               isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY,             isSigner: false, isWritable: false },
          { pubkey: EVENT_AUTHORITY,                 isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM_ID,                isSigner: false, isWritable: false },
        ],
        data,
      });

      // Create ATA if needed
      const ataIx = createAssociatedTokenAccountInstruction(
        this.payer.publicKey,
        buyerATA,
        this.payer.publicKey,
        mintPk,
      );

      return await this.sendWithJito(
        [ataIx, buyIx],
        solAmount,
        expectedTokens,
        t0,
      );
    } catch (err) {
      return {
        success: false,
        signature: null,
        solAmount,
        tokenAmount: 0n,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: performance.now() - t0,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELL
  // ═══════════════════════════════════════════════════════════════════════════

  async sell(
    mint: string,
    tokenAmount: bigint,
    slippageBps = 300,
    vSol?: bigint,
    vToken?: bigint,
  ): Promise<CurveTradeResult> {
    const t0 = performance.now();
    try {
      const mintPk = new PublicKey(mint);
      const [curvePDA] = deriveBondingCurvePDA(mintPk);
      const curveATA = deriveAssociatedBondingCurve(mintPk, curvePDA);
      const sellerATA = getAssociatedTokenAddressSync(mintPk, this.payer.publicKey);

      // Expected SOL output
      let expectedSol = 0n;
      if (vSol && vToken) {
        expectedSol = calcSellOutput(vSol, vToken, tokenAmount);
      }

      // minSolOutput with slippage
      const minSolOutput = expectedSol > 0n
        ? expectedSol - (expectedSol * BigInt(slippageBps)) / 10_000n
        : 0n;

      // Build sell instruction data: discriminator(8) + amount(8) + minSolOutput(8)
      const data = Buffer.alloc(24);
      data.set(SELL_DISCRIMINATOR, 0);
      data.writeBigUInt64LE(tokenAmount, 8);
      data.writeBigUInt64LE(minSolOutput, 16);

      const sellIx = new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: [
          { pubkey: GLOBAL_ACCOUNT,                 isSigner: false, isWritable: false },
          { pubkey: FEE_RECIPIENT,                  isSigner: false, isWritable: true },
          { pubkey: mintPk,                         isSigner: false, isWritable: false },
          { pubkey: curvePDA,                       isSigner: false, isWritable: true },
          { pubkey: curveATA,                       isSigner: false, isWritable: true },
          { pubkey: sellerATA,                      isSigner: false, isWritable: true },
          { pubkey: this.payer.publicKey,            isSigner: true,  isWritable: true },
          { pubkey: SystemProgram.programId,         isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID,               isSigner: false, isWritable: false },
          { pubkey: EVENT_AUTHORITY,                 isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM_ID,                isSigner: false, isWritable: false },
        ],
        data,
      });

      const solOut = Number(expectedSol) / LAMPORTS_PER_SOL;
      return await this.sendWithJito([sellIx], solOut, tokenAmount, t0);
    } catch (err) {
      return {
        success: false,
        signature: null,
        solAmount: 0,
        tokenAmount,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: performance.now() - t0,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Jito Bundle Submission
  // ═══════════════════════════════════════════════════════════════════════════

  private async sendWithJito(
    instructions: TransactionInstruction[],
    solAmount: number,
    tokenAmount: bigint,
    t0: number,
  ): Promise<CurveTradeResult> {
    if (this.isPaper) {
      const ms = performance.now() - t0;
      console.log(`📝 [CurveExecutor] PAPER trade: ${solAmount.toFixed(4)} SOL (${ms.toFixed(1)}ms)`);
      return {
        success: true,
        signature: `paper-${Date.now().toString(36)}`,
        solAmount,
        tokenAmount,
        error: null,
        latencyMs: ms,
      };
    }

    if (process.env.TRADING_ENABLED !== 'true') {
      const ms = performance.now() - t0;
      console.warn(
        '⚠️  [CurveExecutor] TRADING_ENABLED!=true — envoi Pump.fun on-chain bloqué (aligné Sniper / garde capital)',
      );
      return {
        success: false,
        signature: null,
        solAmount,
        tokenAmount,
        error: 'TRADING_ENABLED must be true for live curve execution',
        latencyMs: ms,
      };
    }

    // Jito tip instruction (noUncheckedIndexedAccess: arr[i] is string | undefined)
    const tipIdx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    const tipPk = JITO_TIP_ACCOUNTS[tipIdx] ?? JITO_TIP_ACCOUNTS[0]!;
    const tipAccount = new PublicKey(tipPk);
    const tipIx = SystemProgram.transfer({
      fromPubkey: this.payer.publicKey,
      toPubkey: tipAccount,
      lamports: this.defaultTipLamports,
    });

    const allIx = [...instructions, tipIx];

    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash('confirmed');

    const messageV0 = new TransactionMessage({
      payerKey: this.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: allIx,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([this.payer]);

    const serialized = Buffer.from(tx.serialize()).toString('base64');

    // Submit to Jito bundle API
    try {
      const resp = await fetchWithTimeout(
        `${this.jitoBlockEngineUrl}/api/v1/bundles`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendBundle',
            params: [[serialized]],
          }),
        },
        defaultJitoHttpTimeoutMs(),
      );

      const json = await resp.json() as { result?: string; error?: { message: string } };
      if (json.error) {
        throw new Error(`Jito: ${json.error.message}`);
      }

      const bundleId = json.result ?? 'unknown';
      const ms = performance.now() - t0;
      console.log(`🚀 [CurveExecutor] Bundle sent: ${bundleId} (${ms.toFixed(1)}ms)`);

      // Confirm on-chain
      const sig = await this.connection.confirmTransaction(
        { signature: bundleId, blockhash, lastValidBlockHeight },
        'confirmed',
      );

      return {
        success: !sig.value.err,
        signature: bundleId,
        solAmount,
        tokenAmount,
        error: sig.value.err ? JSON.stringify(sig.value.err) : null,
        latencyMs: performance.now() - t0,
      };
    } catch (err) {
      // Fallback: send directly via RPC
      console.warn('⚠️ [CurveExecutor] Jito failed, fallback to direct send');
      try {
        const signature = await this.connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries: 2,
        });
        const ms = performance.now() - t0;
        console.log(`🚀 [CurveExecutor] Direct send: ${signature.slice(0, 16)}... (${ms.toFixed(1)}ms)`);

        return {
          success: true,
          signature,
          solAmount,
          tokenAmount,
          error: null,
          latencyMs: ms,
        };
      } catch (fallbackErr) {
        return {
          success: false,
          signature: null,
          solAmount,
          tokenAmount,
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          latencyMs: performance.now() - t0,
        };
      }
    }
  }
}
