import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { ExecutionBundle, ScoredToken } from '../types/index.js';
import { defaultJupiterUltraTimeoutMs, fetchWithTimeout } from '../infra/fetchWithTimeout.js';

interface UltraOrderRequest {
  inputMint: string;
  outputMint: string;
  amount: string; // lamports en string
  taker: string; // wallet public key
  slippageBps?: number;
}

interface UltraOrderResponse {
  transaction: string; // base64 — transaction non signée pré-construite
  requestId: string; // lier order → execute
  inputAmount: string;
  outputAmount: string;
  priceImpactPct: number;
  routePlan?: unknown[];
}

interface UltraExecuteRequest {
  signedTransaction: string; // base64 — transaction signée par le wallet
  requestId: string; // doit correspondre à l'order
}

interface UltraExecuteResponse {
  signature: string; // tx signature on-chain
  status: 'Success' | 'Failed';
  error?: string;
  slot?: number;
}

interface JitoBundleClient {
  sendBundle(bundle: unknown): Promise<string>;
}

const TRADING_ENABLED_ENV = 'TRADING_ENABLED';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface SniperConfig {
  rpcUrl: string;
  walletKeypair: Keypair;
  jitoBlockEngineUrl: string;
  jitoAuthKeypair: Keypair;
  jupiterApiUrl?: string;
  swapAmountSol?: number;
  slippageBps?: number;
  ultraApiUrl?: string;
}

export class Sniper {
  private connection: Connection;
  private wallet: Keypair;
  private jitoClient: JitoBundleClient | null = null;
  private jitoAuthKeypair: Keypair;
  private jitoBlockEngineUrl: string;
  private ultraApiUrl: string;
  private swapAmountSol: number;
  private slippageBps: number;

  private readonly CU_LIMIT_SWAP = 140_000;

  private readonly JITO_TIP_ACCOUNTS = [
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  ];

  constructor(config: SniperConfig) {
    this.connection = new Connection(config.rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });

    this.wallet = config.walletKeypair;
    this.jitoAuthKeypair = config.jitoAuthKeypair;
    this.jitoBlockEngineUrl = config.jitoBlockEngineUrl;
    this.ultraApiUrl =
      process.env['JUPITER_ULTRA_URL'] ??
      config.ultraApiUrl ??
      config.jupiterApiUrl ??
      'https://lite-api.jup.ag/ultra/v1';
    this.swapAmountSol = config.swapAmountSol || 0.1;
    this.slippageBps = config.slippageBps || 300;
  }

  async executeSwap(scoredToken: ScoredToken): Promise<string | null> {
    const t0 = performance.now();
    console.log(
      `[Sniper] 🎯 ${scoredToken.token.symbol} (${scoredToken.priority}) | score=${scoredToken.finalScore}`,
    );

    try {
      if (!this.isTradingEnabled()) {
        console.warn(`[Sniper] ${TRADING_ENABLED_ENV}!=true, live execution blocked`);
        return null;
      }

      // Étape 1 : Ultra Order
      const tOrder = performance.now();
      const order = await this.callUltraOrder(scoredToken.token.mint);
      if (!order) {
        return null;
      }
      const orderMs = (performance.now() - tOrder).toFixed(0);

      if ((order.priceImpactPct ?? 0) > 10) {
        console.warn(
          `[Sniper] ⚠️ Price impact trop élevé: ${order.priceImpactPct.toFixed(2)}%`,
        );
        return null;
      }

      // Étape 2 : Shield check
      const shield = await this.checkJupiterShield(scoredToken.token.mint);
      if (!shield.safe) {
        console.warn(`[Sniper] 🛡️ Shield: ${shield.warnings.join(' | ')}`);
        if (scoredToken.priority !== 'HIGH') {
          console.warn('[Sniper] ⚠️ Annulation — non-HIGH + Shield warning');
          return null;
        }
      }

      // Étape 3 : Désérialise + signe la tx
      const tSign = performance.now();
      const txBuffer = Buffer.from(order.transaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuffer);
      this.addComputeBudget(tx, scoredToken.priority);
      tx.sign([this.wallet]);
      const signMs = (performance.now() - tSign).toFixed(0);

      // Étape 4 : Tip Jito
      const slotAge = await this.getSlotAge();
      const jitoTip = this.estimateTip(scoredToken.priority, slotAge);
      const tipTx = await this.createJitoTipTransaction(jitoTip);

      // Étape 5 : Bundle Jito
      const bundle = this.createExecutionBundle(
        [tx, tipTx],
        jitoTip,
        scoredToken.token.mint,
      );
      const bundleSig = await this.sendJitoBundle(bundle);

      if (!bundleSig) {
        console.warn('[Sniper] ⚠️ Jito bundle échoué — fallback Ultra execute');
        const tExec = performance.now();
        const signature = await this.callUltraExecute(tx, order.requestId);
        const execMs = (performance.now() - tExec).toFixed(0);
        const totalMs = (performance.now() - t0).toFixed(0);
        console.log(
          `[Sniper] 📊 order=${orderMs}ms | sign=${signMs}ms | exec=${execMs}ms | TOTAL=${totalMs}ms | tip=${(
            jitoTip / 1e9
          ).toFixed(4)} SOL`,
        );
        return signature;
      }

      const totalMs = (performance.now() - t0).toFixed(0);
      console.log(
        `[Sniper] 📊 order=${orderMs}ms | sign=${signMs}ms | jito=bundle | TOTAL=${totalMs}ms | tip=${(
          jitoTip / 1e9
        ).toFixed(4)} SOL`,
      );
      return bundleSig;
    } catch (error) {
      const elapsed = (performance.now() - t0).toFixed(0);
      console.error(`[Sniper] ❌ Erreur après ${elapsed}ms:`, error);
      return null;
    }
  }

  /**
   * Temporary compatibility shim:
   * `jito-ts@3.0.1` breaks the repo typecheck through its TS sources, so we
   * lazily load the compiled `dist/*` artifact only at runtime.
   */
  private async getJitoClient(): Promise<JitoBundleClient> {
    if (this.jitoClient) {
      return this.jitoClient;
    }

    const { searcherClient } = await import('jito-ts/dist/sdk/block-engine/searcher.js');
    this.jitoClient = searcherClient(
      this.jitoBlockEngineUrl,
      this.jitoAuthKeypair
    ) as JitoBundleClient;

    return this.jitoClient;
  }

  /**
   * Temporary compatibility shim:
   * this dynamic import to `jito-ts/dist/*` is still an internal dependency
   * import and should be removed once a stable public API is available.
   */
  private async createJitoBundle(transactions: VersionedTransaction[]): Promise<unknown> {
    const { Bundle } = await import('jito-ts/dist/sdk/block-engine/types.js');
    return new Bundle(transactions, transactions.length);
  }

  private isTradingEnabled(): boolean {
    return process.env[TRADING_ENABLED_ENV] === 'true';
  }

  private async callUltraOrder(outputMint: string): Promise<UltraOrderResponse | null> {
    const t0 = performance.now();
    try {
      const body: UltraOrderRequest = {
        inputMint: SOL_MINT,
        outputMint,
        amount: Math.floor(this.swapAmountSol * 1e9).toString(),
        taker: this.wallet.publicKey.toBase58(),
        slippageBps: this.slippageBps,
      };

      const resp = await fetch(`${this.ultraApiUrl}/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });

      if (!resp.ok) {
        console.error(
          `[Sniper] ❌ Ultra /order ${resp.status}: ${await resp.text()}`,
        );
        return null;
      }

      const data = (await resp.json()) as UltraOrderResponse;
      console.log(
        `[Sniper] 📋 Ultra order en ${(performance.now() - t0).toFixed(0)}ms` +
          ` | impact=${data.priceImpactPct?.toFixed(2) ?? '?'}%` +
          ` | out=${data.outputAmount}`,
      );
      return data;
    } catch (err) {
      console.error('[Sniper] ❌ callUltraOrder:', err);
      return null;
    }
  }

  private async callUltraExecute(
    signedTx: VersionedTransaction,
    requestId: string,
  ): Promise<string | null> {
    const t0 = performance.now();
    try {
      const serialized = Buffer.from(signedTx.serialize()).toString('base64');

      const body: UltraExecuteRequest = {
        signedTransaction: serialized,
        requestId,
      };

      const resp = await fetchWithTimeout(
        `${this.ultraApiUrl}/execute`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        defaultJupiterUltraTimeoutMs('execute'),
      );

      if (!resp.ok) {
        console.error(
          `[Sniper] ❌ Ultra /execute ${resp.status}: ${await resp.text()}`,
        );
        return null;
      }

      const data = (await resp.json()) as UltraExecuteResponse;
      const elapsed = (performance.now() - t0).toFixed(0);

      if (data.status !== 'Success') {
        console.error(
          `[Sniper] ❌ Ultra execute status=${data.status} | ${data.error}`,
        );
        return null;
      }

      console.log(
        `[Sniper] ✅ Ultra execute en ${elapsed}ms | sig=${data.signature?.slice(
          0,
          12,
        )}…`,
      );
      return data.signature;
    } catch (err) {
      console.error('[Sniper] ❌ callUltraExecute:', err);
      return null;
    }
  }

  private async createJitoTipTransaction(tipLamports: number): Promise<VersionedTransaction> {
    const randomIndex = Math.floor(Math.random() * this.JITO_TIP_ACCOUNTS.length);
    const randomTipAccount = this.JITO_TIP_ACCOUNTS[randomIndex];

    if (!randomTipAccount) {
      throw new Error('No Jito tip account available');
    }

    const tipAccount = new PublicKey(randomTipAccount);
    const { SystemProgram } = await import('@solana/web3.js');

    const transferIx = SystemProgram.transfer({
      fromPubkey: this.wallet.publicKey,
      toPubkey: tipAccount,
      lamports: tipLamports,
    });

    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    const messageV0 = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [transferIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([this.wallet]);
    return tx;
  }

  private computeCUPrice(priority: 'HIGH' | 'MEDIUM' | 'LOW'): number {
    const targets: Record<'HIGH' | 'MEDIUM' | 'LOW', number> = {
      HIGH: 2_000_000,
      MEDIUM: 500_000,
      LOW: 100_000,
    };
    return Math.ceil((targets[priority] * 1_000_000) / this.CU_LIMIT_SWAP);
  }

  private addComputeBudget(
    tx: VersionedTransaction,
    priority: 'HIGH' | 'MEDIUM' | 'LOW',
  ): void {
    try {
      const cbProgramId = ComputeBudgetProgram.programId.toBase58();
      const hasCB = tx.message.staticAccountKeys.some(
        (k) => k.toBase58() === cbProgramId,
      );

      if (hasCB) {
        console.log('[Sniper] 💻 CB: déjà présent (Jupiter), skip injection');
        return;
      }

      const decompiledMsg = TransactionMessage.decompile(tx.message);

      const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: this.CU_LIMIT_SWAP,
      });
      const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: this.computeCUPrice(priority),
      });

      decompiledMsg.instructions = [cuLimitIx, cuPriceIx, ...decompiledMsg.instructions];

      const recompiledMsg = decompiledMsg.compileToV0Message();

      tx.message = recompiledMsg;

      const price = this.computeCUPrice(priority);
      const approxPriorityFeeSol =
        (this.CU_LIMIT_SWAP * price) / 1_000_000 / 1e9;

      console.log(
        `[Sniper] 💻 CB injecté: limit=${this.CU_LIMIT_SWAP} | price=${price} µL` +
          ` | priority_fee≈${approxPriorityFeeSol.toFixed(5)} SOL`,
      );
    } catch (err) {
      console.warn('[Sniper] ⚠️ addComputeBudget failed (tx part sans CB):', err);
    }
  }

  private estimateTip(
    priority: 'HIGH' | 'MEDIUM' | 'LOW',
    slotAge: number = 0,
  ): number {
    const base: Record<'HIGH' | 'MEDIUM' | 'LOW', number> = {
      HIGH: 50_000_000,
      MEDIUM: 10_000_000,
      LOW: 1_000_000,
    };

    const multiplier = slotAge > 8 ? 1.8 : slotAge > 3 ? 1.3 : 1.0;
    const tip = Math.floor(base[priority] * multiplier);

    if (multiplier > 1.0) {
      console.log(
        `[Sniper] ⚡ Congestion détectée (slotAge=${slotAge})` +
          ` | tip multiplier=${multiplier}×` +
          ` | tip=${(tip / 1e9).toFixed(4)} SOL`,
      );
    }

    return tip;
  }

  private cachedSlotAge = 0;
  private lastSlotCheck = 0;

  private async getSlotAge(): Promise<number> {
    const now = Date.now();
    if (now - this.lastSlotCheck > 2_000) {
      this.lastSlotCheck = now;
      this.connection
        .getSlot('confirmed')
        .then(() => {
          this.cachedSlotAge = Math.floor((Date.now() - this.lastSlotCheck) / 400);
        })
        .catch(() => {});
    }
    return this.cachedSlotAge;
  }

  private async checkJupiterShield(
    mint: string,
  ): Promise<{
    safe: boolean;
    warnings: string[];
  }> {
    try {
      const resp = await fetchWithTimeout(
        `${this.ultraApiUrl}/shield?mints=${mint}`,
        {},
        defaultJupiterUltraTimeoutMs('shield'),
      );
      if (!resp.ok) return { safe: true, warnings: [] };

      const data = (await resp.json()) as {
        warnings?: Array<{ message: string; severity: string }>;
      };

      const warnings = (data.warnings ?? []).map((w) => w.message);
      return { safe: warnings.length === 0, warnings };
    } catch {
      return { safe: true, warnings: [] };
    }
  }

  private createExecutionBundle(
    transactions: VersionedTransaction[],
    jitoTipLamports: number,
    targetToken: string
  ): ExecutionBundle {
    return {
      transactions,
      jitoTipLamports,
      targetToken,
    };
  }

  private async sendJitoBundle(bundle: ExecutionBundle): Promise<string | null> {
    if (!this.isTradingEnabled()) {
      console.warn(`[Sniper] ${TRADING_ENABLED_ENV}!=true, bundle submission blocked`);
      return null;
    }

    try {
      const jitoClient = await this.getJitoClient();
      const jitoBundle = await this.createJitoBundle(bundle.transactions);
      const bundleId = await jitoClient.sendBundle(jitoBundle);

      console.log(`[Sniper] Bundle ID: ${bundleId}`);

      if (bundle.transactions.length === 0) {
        console.error('[Sniper] No transaction in bundle');
        return null;
      }

      const firstTx = bundle.transactions[0]!;
      const firstSignature = firstTx.signatures[0];

      if (!firstSignature) {
        console.error('[Sniper] Missing signature on first bundle transaction');
        return null;
      }

      return bs58.encode(firstSignature);
    } catch (error) {
      console.error('[Sniper] sendJitoBundle error:', error);
      return null;
    }
  }

  async simulateTransaction(tx: VersionedTransaction): Promise<boolean> {
    try {
      const simulation = await this.connection.simulateTransaction(tx, {
        commitment: 'confirmed',
        replaceRecentBlockhash: true,
      });

      if (simulation.value.err) {
        console.error('[Sniper] Simulation failed:', simulation.value.err);
        return false;
      }

      console.log(`[Sniper] Simulation OK - Compute units: ${simulation.value.unitsConsumed}`);
      return true;
    } catch (error) {
      console.error('[Sniper] simulateTransaction error:', error);
      return false;
    }
  }

  async checkTransactionStatus(signature: string): Promise<'confirmed' | 'finalized' | null> {
    try {
      const status = await this.connection.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      });

      if (!status.value) {
        return null;
      }

      if (status.value.confirmationStatus === 'finalized') {
        return 'finalized';
      }

      if (status.value.confirmationStatus === 'confirmed') {
        return 'confirmed';
      }

      return null;
    } catch (error) {
      console.error('[Sniper] checkTransactionStatus error:', error);
      return null;
    }
  }

  getConfig() {
    return {
      swapAmountSol: this.swapAmountSol,
      slippageBps: this.slippageBps,
      ultraApiUrl: this.ultraApiUrl,
      tradingEnabled: this.isTradingEnabled(),
    };
  }
}
