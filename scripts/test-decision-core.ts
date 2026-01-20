#!/usr/bin/env bun
/**
 * Script de test pour le DecisionCore complet
 * 
 * Usage: bun scripts/test-decision-core.ts
 */

import { DecisionCore } from '../src/engine/DecisionCore';
import type { ScoredToken } from '../src/types/index';

async function main() {
  console.log('🚀 Test du DecisionCore - Pipeline Complet\n');
  console.log('📊 MarketScanner → Guard → DecisionCore → Sniper\n');

  const core = new DecisionCore({
    minLiquidity: 5, // 5 SOL minimum
    maxRiskScore: 50, // Risk score max 50
    fastCheckThreshold: 100, // FastCheck si > 100 SOL
    enableFastCheck: true,
  });

  // Compteurs
  let tokensScored = 0;
  let readyToSnipe = 0;

  // Écoute les tokens scorés
  core.on('tokenScored', (token: ScoredToken) => {
    tokensScored++;
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 TOKEN SCORÉ');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📍 Mint: ${token.token.mint}`);
    console.log(`🏊 Pool: ${token.poolId}`);
    console.log(`💧 Liquidité: ${token.initialLiquiditySol.toFixed(2)} SOL`);
    console.log(`🎯 Score Final: ${token.finalScore}/100`);
    console.log(`⚡ Priorité: ${token.priority}`);
    console.log(`🛡️  Risk Score: ${token.security.riskScore}/100`);
    console.log(`✅ Safe: ${token.security.isSafe ? 'OUI' : 'NON'}`);
    
    if (token.security.flags.length > 0) {
      console.log(`🚩 Flags: ${token.security.flags.join(', ')}`);
    }
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  });

  // Écoute les tokens prêts pour snipe
  core.on('readyToSnipe', (token: ScoredToken) => {
    readyToSnipe++;
    console.log('\n🚀🚀🚀 READY TO SNIPE 🚀🚀🚀');
    console.log(`🎯 Token: ${token.token.mint}`);
    console.log(`💰 Liquidité: ${token.initialLiquiditySol.toFixed(2)} SOL`);
    console.log(`📈 Score: ${token.finalScore}/100`);
    console.log(`⚡ Priorité: ${token.priority}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // TODO: Ici on appellerait le Sniper
    // await sniper.execute(token);
  });

  // Écoute les rejets
  core.on('tokenRejected', (mint: string, reason: string) => {
    // Silencieux pour ne pas polluer les logs
  });

  // Démarre le core
  try {
    await core.start();

    // Affiche les stats toutes les 30 secondes
    const statsInterval = setInterval(() => {
      const stats = core.getStats();
      console.log('\n📊 Stats DecisionCore:');
      console.log(`   - Tokens traités: ${stats.tokensProcessed}`);
      console.log(`   - Tokens acceptés: ${stats.tokensAccepted}`);
      console.log(`   - Tokens rejetés: ${stats.tokensRejected}`);
      console.log(`   - Taux d'acceptation: ${stats.acceptanceRate.toFixed(2)}%`);
      console.log(`   - Prêts pour snipe: ${readyToSnipe}\n`);
    }, 30000);

    // Gestion propre de l'arrêt
    process.on('SIGINT', async () => {
      console.log('\n\n🛑 Arrêt demandé...');
      clearInterval(statsInterval);
      await core.stop();
      
      const stats = core.getStats();
      console.log('\n📊 Résumé final:');
      console.log(`   - Tokens traités: ${stats.tokensProcessed}`);
      console.log(`   - Tokens acceptés: ${stats.tokensAccepted} (${stats.acceptanceRate.toFixed(2)}%)`);
      console.log(`   - Prêts pour snipe: ${readyToSnipe}`);
      
      process.exit(0);
    });

    // Garde le processus actif
    await new Promise(() => {}); // Infini
  } catch (error) {
    console.error('❌ Erreur fatale:', error);
    process.exit(1);
  }
}

main();
