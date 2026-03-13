import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { ExecutionBundle, ScoredToken } from '../types/index.js';

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: number;
  routePlan: unknown[];
}

interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

interface JitoBundleClient {
  sendBundle(bundle: unknown): Promise<string>;
}

const TRADING_ENABLED_ENV = 'TRADING_ENABLED';

export interface SniperConfig {
  rpcUrl: string;
  walletKeypair: Keypair;
  jitoBlockEngineUrl: string;
  jitoAuthKeypair: Keypair;
  jupiterApiUrl?: string;
  swapAmountSol?: number;
  slippageBps?: number;
}

export class Sniper {
  private connection: Connection;
  private wallet: Keypair;
  private jitoClient: JitoBundleClient | null = null;
  private jitoAuthKeypair: Keypair;
  private jitoBlockEngineUrl: string;
  private jupiterApiUrl: string;
  private swapAmountSol: number;
  private slippageBps: number;

  private readonly TIP_HIGH = 50_000_000;
  private readonly TIP_MEDIUM = 10_000_000;
  private readonly TIP_LOW = 1_000_000;

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
    this.jupiterApiUrl = config.jupiterApiUrl || 'https://quote-api.jup.ag/v6';
    this.swapAmountSol = config.swapAmountSol || 0.1;
    this.slippageBps = config.slippageBps || 300;
  }

  async executeSwap(scoredToken: ScoredToken): Promise<string | null> {
    const startTime = Date.now();

    try {
      if (!this.isTradingEnabled()) {
        console.warn(`[Sniper] ${TRADING_ENABLED_ENV}!=true, live execution blocked`);
        return null;
      }

      console.log(`[Sniper] Executing swap for ${scoredToken.token.symbol} (${scoredToken.priority})`);

      const quote = await this.getJupiterQuote(scoredToken.token.mint);
      if (!quote) {
        console.error('[Sniper] Unable to fetch Jupiter quote');
        return null;
      }

      console.log(`[Sniper] Quote: ${quote.inAmount} SOL -> ${quote.outAmount} ${scoredToken.token.symbol}`);
      console.log(`[Sniper] Price impact: ${quote.priceImpactPct.toFixed(2)}%`);

      if (quote.priceImpactPct > 10) {
        console.warn(`[Sniper] Price impact too high (${quote.priceImpactPct.toFixed(2)}%), aborting`);
        return null;
      }

      const swapTx = await this.createSwapTransaction(quote);
      if (!swapTx) {
        console.error('[Sniper] Unable to create swap transaction');
        return null;
      }

      const jitoTip = this.calculateJitoTip(scoredToken.priority);
      const tipTx = await this.createJitoTipTransaction(jitoTip);
      const bundle = this.createExecutionBundle([swapTx, tipTx], jitoTip, scoredToken.token.mint);

      console.log(`[Sniper] Jito tip: ${(jitoTip / 1e9).toFixed(4)} SOL`);

      const signature = await this.sendJitoBundle(bundle);
      const elapsed = Date.now() - startTime;
      console.log(`[Sniper] Bundle submitted in ${elapsed}ms - Signature: ${signature}`);

      return signature;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.error(`[Sniper] Error after ${elapsed}ms:`, error);
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

  private async getJupiterQuote(outputMint: string): Promise<JupiterQuoteResponse | null> {
    try {
      const inputMint = 'So11111111111111111111111111111111111111112';
      const amountLamports = Math.floor(this.swapAmountSol * 1e9);

      const url = `${this.jupiterApiUrl}/quote?` + new URLSearchParams({
        inputMint,
        outputMint,
        amount: amountLamports.toString(),
        slippageBps: this.slippageBps.toString(),
        onlyDirectRoutes: 'false',
        asLegacyTransaction: 'false',
      });

      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[Sniper] Jupiter quote API error: ${response.status} ${response.statusText}`);
        return null;
      }

      return (await response.json()) as JupiterQuoteResponse;
    } catch (error) {
      console.error('[Sniper] getJupiterQuote error:', error);
      return null;
    }
  }

  private async createSwapTransaction(
    quote: JupiterQuoteResponse
  ): Promise<VersionedTransaction | null> {
    try {
      const response = await fetch(`${this.jupiterApiUrl}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }),
      });

      if (!response.ok) {
        console.error(`[Sniper] Jupiter swap API error: ${response.status}`);
        return null;
      }

      const swapResponse = (await response.json()) as JupiterSwapResponse;
      const txBuffer = Buffer.from(swapResponse.swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuffer);
      tx.sign([this.wallet]);
      return tx;
    } catch (error) {
      console.error('[Sniper] createSwapTransaction error:', error);
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

  private calculateJitoTip(priority: 'HIGH' | 'MEDIUM' | 'LOW'): number {
    switch (priority) {
      case 'HIGH':
        return this.TIP_HIGH;
      case 'MEDIUM':
        return this.TIP_MEDIUM;
      case 'LOW':
      default:
        return this.TIP_LOW;
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
      tipHigh: this.TIP_HIGH / 1e9,
      tipMedium: this.TIP_MEDIUM / 1e9,
      tipLow: this.TIP_LOW / 1e9,
      tradingEnabled: this.isTradingEnabled(),
    };
  }
}
