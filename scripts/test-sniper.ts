/**
 * Script de test pour Sniper.ts
 * 
 * IMPORTANT: Ce script est à des fins de démonstration uniquement.
 * Il utilise des données simulées et NE PAS exécuter en production sans configuration appropriée.
 * 
 * Usage:
 *   bun scripts/test-sniper.ts
 */

import { Sniper } from '../src/executor/Sniper.js';
import { Keypair } from '@solana/web3.js';
import type { ScoredToken } from '../src/types/index.js';
import bs58 from 'bs58';

// ⚠️ Configuration de test (REMPLACER avec vos vraies valeurs)
const TEST_CONFIG = {
  RPC_URL: process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com',
  WALLET_KEY: process.env.WALLET_PRIVATE_KEY || '', // Base58 encoded
  JITO_AUTH_KEY: process.env.JITO_AUTH_PRIVATE_KEY || '', // Base58 encoded
  JITO_BLOCK_ENGINE: 'https://mainnet.block-engine.jito.wtf',
  SWAP_AMOUNT_SOL: 0.01, // Montant de test (0.01 SOL)
};

// Token de test (exemple avec BONK)
const TEST_SCORED_TOKEN: ScoredToken = {
  token: {
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK mint address
    symbol: 'BONK',
    name: 'Bonk',
    decimals: 5,
  },
  poolId: 'test-pool-id',
  initialLiquiditySol: 150,
  initialPriceUsdc: 0.000012,
  timestamp: Date.now(),
  t_source: Date.now(),
  t_recv: Date.now(),
  social: {
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    ticker: 'BONK',
    platform: 'X',
    authorTrustScore: 85,
    followerCount: 120000,
    velocity30s: 25,
    sentiment: 0.9,
  },
  security: {
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    isSafe: true,
    riskScore: 15,
    flags: [],
    details: {
      mintRenounced: true,
      freezeDisabled: true,
      lpBurnedPercent: 100,
      top10HoldersPercent: 8,
      isHoneypot: false,
      liquiditySol: 150,
      hasLiquidity: true,
    },
  },
  finalScore: 92,
  priority: 'HIGH',
};

async function testSniperQuote() {
  console.log('\n📊 Test 1: Récupération de Quote Jupiter');
  console.log('='.repeat(60));

  try {
    // Crée un Sniper avec des keypairs temporaires (pour test quote uniquement)
    const tempWallet = Keypair.generate();
    const tempJitoAuth = Keypair.generate();

    const sniper = new Sniper({
      rpcUrl: TEST_CONFIG.RPC_URL,
      walletKeypair: tempWallet,
      jitoBlockEngineUrl: TEST_CONFIG.JITO_BLOCK_ENGINE,
      jitoAuthKeypair: tempJitoAuth,
      swapAmountSol: TEST_CONFIG.SWAP_AMOUNT_SOL,
      slippageBps: 300,
    });

    console.log('Wallet (test):', tempWallet.publicKey.toBase58());
    console.log('Token:', TEST_SCORED_TOKEN.token.symbol);
    console.log('Montant:', TEST_CONFIG.SWAP_AMOUNT_SOL, 'SOL\n');

    // Récupère une quote (sans exécuter)
    const quote = await (sniper as any).getJupiterQuote(TEST_SCORED_TOKEN.token.mint);

    if (quote) {
      console.log('✅ Quote récupérée avec succès!');
      console.log(`   Input: ${(parseInt(quote.inAmount) / 1e9).toFixed(4)} SOL`);
      console.log(`   Output: ${quote.outAmount} ${TEST_SCORED_TOKEN.token.symbol}`);
      console.log(`   Price Impact: ${quote.priceImpactPct.toFixed(4)}%`);
      console.log(`   Slippage: ${quote.slippageBps / 100}%`);
      console.log(`   Route: ${quote.routePlan.length} swaps`);
    } else {
      console.log('❌ Impossible de récupérer la quote');
    }
  } catch (error) {
    console.error('❌ Erreur:', error);
  }
}

async function testSniperConfig() {
  console.log('\n⚙️  Test 2: Configuration du Sniper');
  console.log('='.repeat(60));

  try {
    const tempWallet = Keypair.generate();
    const tempJitoAuth = Keypair.generate();

    const sniper = new Sniper({
      rpcUrl: TEST_CONFIG.RPC_URL,
      walletKeypair: tempWallet,
      jitoBlockEngineUrl: TEST_CONFIG.JITO_BLOCK_ENGINE,
      jitoAuthKeypair: tempJitoAuth,
      swapAmountSol: 0.05,
      slippageBps: 500,
    });

    const config = sniper.getConfig();

    console.log('✅ Configuration chargée:');
    console.log(`   Swap Amount: ${config.swapAmountSol} SOL`);
    console.log(`   Slippage: ${config.slippageBps / 100}%`);
    console.log(`   Tip policy: dynamique (heuristique slotAge)`);
  } catch (error) {
    console.error('❌ Erreur:', error);
  }
}

async function testSniperExecution() {
  console.log('\n🎯 Test 3: Exécution de Swap (SIMULATION)');
  console.log('='.repeat(60));

  if (!TEST_CONFIG.WALLET_KEY || !TEST_CONFIG.JITO_AUTH_KEY) {
    console.log('⚠️  Variables d\'environnement manquantes:');
    console.log('   - WALLET_PRIVATE_KEY (base58)');
    console.log('   - JITO_AUTH_PRIVATE_KEY (base58)');
    console.log('\n   Ce test est ignoré (nécessite des clés valides).');
    return;
  }

  try {
    const walletKeypair = Keypair.fromSecretKey(bs58.decode(TEST_CONFIG.WALLET_KEY));
    const jitoAuthKeypair = Keypair.fromSecretKey(bs58.decode(TEST_CONFIG.JITO_AUTH_KEY));

    const sniper = new Sniper({
      rpcUrl: TEST_CONFIG.RPC_URL,
      walletKeypair,
      jitoBlockEngineUrl: TEST_CONFIG.JITO_BLOCK_ENGINE,
      jitoAuthKeypair,
      swapAmountSol: TEST_CONFIG.SWAP_AMOUNT_SOL,
      slippageBps: 300,
    });

    console.log('Wallet:', walletKeypair.publicKey.toBase58());
    console.log('Token:', TEST_SCORED_TOKEN.token.symbol);
    console.log('Priority:', TEST_SCORED_TOKEN.priority);
    console.log('Final Score:', TEST_SCORED_TOKEN.finalScore);
    console.log('\n⚠️  ATTENTION: Ceci exécutera un vrai swap avec', TEST_CONFIG.SWAP_AMOUNT_SOL, 'SOL');
    console.log('Appuyez sur Ctrl+C pour annuler dans les 5 secondes...\n');

    // Délai de sécurité
    await new Promise((resolve) => setTimeout(resolve, 5000));

    console.log('🚀 Exécution du swap...');
    const signature = await sniper.executeSwap(TEST_SCORED_TOKEN);

    if (signature) {
      console.log('✅ Swap exécuté!');
      console.log(`   Signature: ${signature}`);
      console.log(`   Explorer: https://solscan.io/tx/${signature}`);

      // Attendre confirmation
      console.log('\n⏳ Attente de confirmation...');
      let status = null;
      let attempts = 0;

      while (!status && attempts < 30) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        status = await sniper.checkTransactionStatus(signature);
        
        if (status) {
          console.log(`✅ Transaction ${status}!`);
        } else {
          process.stdout.write('.');
        }
        
        attempts++;
      }

      if (!status) {
        console.log('\n⚠️  Timeout: transaction non confirmée après 60s');
      }
    } else {
      console.log('❌ Échec du swap');
    }
  } catch (error) {
    console.error('❌ Erreur:', error);
  }
}

async function main() {
  console.log('🤖 APEX-2026 - Test du Sniper HFT');
  console.log('='.repeat(60));

  // Test 1: Quote Jupiter (sans exécution)
  await testSniperQuote();

  // Test 2: Configuration
  await testSniperConfig();

  // Test 3: Exécution réelle (nécessite clés)
  // ⚠️ Commenté par défaut pour éviter les swaps accidentels
  // await testSniperExecution();

  console.log('\n✅ Tests terminés!');
  console.log('\n💡 Pour tester l\'exécution réelle:');
  console.log('   1. Configure WALLET_PRIVATE_KEY et JITO_AUTH_PRIVATE_KEY dans .env');
  console.log('   2. Décommente la ligne "await testSniperExecution()" dans ce script');
  console.log('   3. Lance: bun scripts/test-sniper.ts');
  console.log('\n⚠️  ATTENTION: L\'exécution utilise de vrais SOL!');
}

main().catch(console.error);
