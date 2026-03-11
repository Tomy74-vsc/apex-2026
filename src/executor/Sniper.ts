import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';
import type { ScoredToken, ExecutionBundle } from '../types/index.js';
import bs58 from 'bs58';

/**
 * Sniper - Module d'exécution HFT pour trades Solana via Jito + Jupiter
 * 
 * Features:
 * - Swap SOL -> Token via Jupiter API v6
 * - Jito Bundle pour inclusion garantie
 * - Tip dynamique selon priority (HIGH/MEDIUM/LOW)
 * - Gestion des Address Lookup Tables
 * - Latence optimisée (< 100ms pour construire le bundle)
 */

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: number;
  routePlan: any[];
}

interface JupiterSwapResponse {
  swapTransaction: string; // Base64 serialized transaction
  lastValidBlockHeight: number;
}

interface JitoBundleClient {
  sendBundle(bundle: unknown): Promise<string>;
}

export interface SniperConfig {
  rpcUrl: string;
  walletKeypair: Keypair;
  jitoBlockEngineUrl: string;
  jitoAuthKeypair: Keypair; // Keypair pour authentification Jito
  jupiterApiUrl?: string;
  swapAmountSol?: number; // Montant à swap (défaut: 0.1 SOL)
  slippageBps?: number; // Slippage en basis points (défaut: 300 = 3%)
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

  // Jito Tip selon priority (en lamports)
  private readonly TIP_HIGH = 50_000_000; // 0.05 SOL
  private readonly TIP_MEDIUM = 10_000_000; // 0.01 SOL
  private readonly TIP_LOW = 1_000_000; // 0.001 SOL

  // Jito Block Engine endpoints (mainnet-beta)
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
    this.slippageBps = config.slippageBps || 300; // 3% par défaut
  }

  /**
   * Exécute un swap SOL -> Token via Jupiter + Jito Bundle
   * 
   * @param scoredToken - Token évalué par DecisionCore
   * @returns Signature de la transaction ou null si échec
   */
  async executeSwap(scoredToken: ScoredToken): Promise<string | null> {
    const startTime = Date.now();
    
    try {
      console.log(`[Sniper] 🎯 Exécution swap pour ${scoredToken.token.symbol} (${scoredToken.priority})`);

      // 1. Récupérer la route Jupiter
      const quote = await this.getJupiterQuote(scoredToken.token.mint);
      if (!quote) {
        console.error('[Sniper] ❌ Impossible de récupérer quote Jupiter');
        return null;
      }

      console.log(`[Sniper] 📊 Quote: ${quote.inAmount} SOL -> ${quote.outAmount} ${scoredToken.token.symbol}`);
      console.log(`[Sniper] 💥 Price Impact: ${quote.priceImpactPct.toFixed(2)}%`);

      // Vérification du price impact (sécurité)
      if (quote.priceImpactPct > 10) {
        console.warn(`[Sniper] ⚠️ Price impact trop élevé (${quote.priceImpactPct.toFixed(2)}%), annulation`);
        return null;
      }

      // 2. Créer la transaction de swap
      const swapTx = await this.createSwapTransaction(quote);
      if (!swapTx) {
        console.error('[Sniper] ❌ Impossible de créer transaction swap');
        return null;
      }

      // 3. Ajouter Jito Tip selon priority
      const jitoTip = this.calculateJitoTip(scoredToken.priority);
      const tipTx = await this.createJitoTipTransaction(jitoTip);

      // 4. Créer le bundle Jito
      const bundle = this.createExecutionBundle([swapTx, tipTx], jitoTip, scoredToken.token.mint);

      console.log(`[Sniper] 💰 Jito Tip: ${(jitoTip / 1e9).toFixed(4)} SOL`);

      // 5. Envoyer au Block Engine
      const signature = await this.sendJitoBundle(bundle);

      const elapsed = Date.now() - startTime;
      console.log(`[Sniper] ✅ Bundle envoyé en ${elapsed}ms - Signature: ${signature}`);

      return signature;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.error(`[Sniper] ❌ Erreur après ${elapsed}ms:`, error);
      return null;
    }
  }

  /**
   * Charge le client Jito à la demande pour éviter que ses types internes
   * ne contaminent le typecheck du reste du repo.
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
   * Construit un bundle Jito à l'exécution pour éviter les imports source `jito-ts/src/*`.
   */
  private async createJitoBundle(transactions: VersionedTransaction[]): Promise<unknown> {
    const { Bundle } = await import('jito-ts/dist/sdk/block-engine/types.js');
    return new Bundle(transactions, transactions.length);
  }

  /**
   * Récupère une quote de Jupiter API v6
   * 
   * @param outputMint - Token de destination
   * @returns Quote Jupiter ou null
   */
  private async getJupiterQuote(outputMint: string): Promise<JupiterQuoteResponse | null> {
    try {
      const inputMint = 'So11111111111111111111111111111111111111112'; // Wrapped SOL
      const amountLamports = Math.floor(this.swapAmountSol * 1e9);

      const url = `${this.jupiterApiUrl}/quote?` + new URLSearchParams({
        inputMint,
        outputMint,
        amount: amountLamports.toString(),
        slippageBps: this.slippageBps.toString(),
        onlyDirectRoutes: 'false',
        asLegacyTransaction: 'false', // Force VersionedTransaction
      });

      const response = await fetch(url);
      
      if (!response.ok) {
        console.error(`[Sniper] Jupiter API error: ${response.status} ${response.statusText}`);
        return null;
      }

      const quote = await response.json() as JupiterQuoteResponse;
      return quote;
    } catch (error) {
      console.error('[Sniper] Erreur getJupiterQuote:', error);
      return null;
    }
  }

  /**
   * Crée une VersionedTransaction de swap via Jupiter
   * 
   * @param quote - Quote Jupiter
   * @returns Transaction signée ou null
   */
  private async createSwapTransaction(quote: JupiterQuoteResponse): Promise<VersionedTransaction | null> {
    try {
      const swapUrl = `${this.jupiterApiUrl}/swap`;
      
      const response = await fetch(swapUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true, // Optimise compute units
          prioritizationFeeLamports: 'auto', // Priority fees automatiques
        }),
      });

      if (!response.ok) {
        console.error(`[Sniper] Jupiter swap API error: ${response.status}`);
        return null;
      }

      const swapResponse = await response.json() as JupiterSwapResponse;
      const { swapTransaction } = swapResponse;

      // Désérialiser la transaction
      const txBuffer = Buffer.from(swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuffer);

      // Signer avec le wallet
      tx.sign([this.wallet]);

      return tx;
    } catch (error) {
      console.error('[Sniper] Erreur createSwapTransaction:', error);
      return null;
    }
  }

  /**
   * Crée une transaction de tip Jito
   * 
   * @param tipLamports - Montant du tip en lamports
   * @returns Transaction de tip signée
   */
  private async createJitoTipTransaction(tipLamports: number): Promise<VersionedTransaction> {
    // Sélectionne un tip account aléatoire (load balancing)
    const randomIndex = Math.floor(Math.random() * this.JITO_TIP_ACCOUNTS.length);
    const randomTipAccount = this.JITO_TIP_ACCOUNTS[randomIndex];

    if (!randomTipAccount) {
      throw new Error('Aucun tip account Jito disponible');
    }

    const tipAccount = new PublicKey(randomTipAccount);

    // Instruction de transfert SOL
    const { SystemProgram } = await import('@solana/web3.js');
    
    const transferIx = SystemProgram.transfer({
      fromPubkey: this.wallet.publicKey,
      toPubkey: tipAccount,
      lamports: tipLamports,
    });

    // Récupère le blockhash récent
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

    // Crée le message de transaction
    const messageV0 = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [transferIx],
    }).compileToV0Message();

    // Crée et signe la transaction
    const tx = new VersionedTransaction(messageV0);
    tx.sign([this.wallet]);

    return tx;
  }

  /**
   * Calcule le montant du tip Jito selon la priority
   * 
   * @param priority - Niveau de priorité du token
   * @returns Montant en lamports
   */
  private calculateJitoTip(priority: 'HIGH' | 'MEDIUM' | 'LOW'): number {
    switch (priority) {
      case 'HIGH':
        return this.TIP_HIGH;
      case 'MEDIUM':
        return this.TIP_MEDIUM;
      case 'LOW':
        return this.TIP_LOW;
      default:
        return this.TIP_LOW;
    }
  }

  /**
   * Crée un ExecutionBundle selon l'interface définie
   * 
   * @param transactions - Transactions du bundle
   * @param jitoTipLamports - Montant du tip
   * @param targetToken - Token cible
   * @returns ExecutionBundle
   */
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

  /**
   * Envoie le bundle au Block Engine de Jito
   * 
   * @param bundle - Bundle à envoyer
   * @returns Signature de la première transaction ou null
   */
  private async sendJitoBundle(bundle: ExecutionBundle): Promise<string | null> {
    try {
      const jitoClient = await this.getJitoClient();
      const jitoBundle = await this.createJitoBundle(bundle.transactions);

      // Envoie au Block Engine
      const bundleId = await jitoClient.sendBundle(jitoBundle);

      console.log(`[Sniper] 📦 Bundle ID: ${bundleId}`);

      // Retourne la signature de la première transaction (swap)
      // Note: en prod, implémenter un système de tracking du bundle
      if (bundle.transactions.length === 0) {
        console.error('[Sniper] ❌ Aucune transaction dans le bundle');
        return null;
      }
      
      const firstTx = bundle.transactions[0]!; // Non-null assertion car on vérifie length > 0
      const firstSignature = firstTx.signatures[0];
      
      if (!firstSignature) {
        console.error('[Sniper] ❌ Aucune signature trouvée sur la première transaction');
        return null;
      }
      
      return bs58.encode(firstSignature);
    } catch (error) {
      console.error('[Sniper] Erreur sendJitoBundle:', error);
      return null;
    }
  }

  /**
   * Simule une transaction avant exécution (optionnel, pour tests)
   * 
   * @param tx - Transaction à simuler
   * @returns Résultat de simulation
   */
  async simulateTransaction(tx: VersionedTransaction): Promise<boolean> {
    try {
      const simulation = await this.connection.simulateTransaction(tx, {
        commitment: 'confirmed',
        replaceRecentBlockhash: true,
      });

      if (simulation.value.err) {
        console.error('[Sniper] ❌ Simulation failed:', simulation.value.err);
        return false;
      }

      console.log(`[Sniper] ✅ Simulation OK - Compute units: ${simulation.value.unitsConsumed}`);
      return true;
    } catch (error) {
      console.error('[Sniper] Erreur simulation:', error);
      return false;
    }
  }

  /**
   * Vérifie le statut d'une transaction
   * 
   * @param signature - Signature de la transaction
   * @returns Statut (confirmé ou null)
   */
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
      console.error('[Sniper] Erreur checkTransactionStatus:', error);
      return null;
    }
  }

  /**
   * Statistiques pour monitoring
   */
  getConfig() {
    return {
      swapAmountSol: this.swapAmountSol,
      slippageBps: this.slippageBps,
      tipHigh: this.TIP_HIGH / 1e9,
      tipMedium: this.TIP_MEDIUM / 1e9,
      tipLow: this.TIP_LOW / 1e9,
    };
  }
}
