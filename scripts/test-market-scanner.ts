#!/usr/bin/env bun
/**
 * Script de test pour le MarketScanner
 * 
 * Usage: bun scripts/test-market-scanner.ts
 */

import { MarketScanner } from '../src/ingestors/MarketScanner';
import { Guard } from '../src/detectors/Guard';
import type { MarketEvent } from '../src/types/index';

async function main() {
  console.log('🚀 Test du MarketScanner - Surveillance Raydium AMM v4\n');

  // Initialise le Guard pour FastCheck
  const guard = new Guard();

  // Créer le scanner
  const scanner = new MarketScanner({
    fastCheckThreshold: 100, // 100 SOL
  });

  // Compteurs de stats
  let tokensDetected = 0;
  let fastCheckTriggered = 0;

  // Écoute les événements
  scanner.on('connected', () => {
    console.log('✅ Scanner connecté au WebSocket\n');
    console.log('⏳ En attente de nouveaux pools...\n');
  });

  scanner.on('newToken', async (event: MarketEvent) => {
    tokensDetected++;
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🆕 NOUVEAU TOKEN DÉTECTÉ');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📍 Mint: ${event.token.mint}`);
    console.log(`🏊 Pool ID: ${event.poolId}`);
    console.log(`💧 Liquidité: ${event.initialLiquiditySol.toFixed(2)} SOL`);
    console.log(`💰 Prix initial: $${event.initialPriceUsdc.toFixed(6)}`);
    console.log(`🔢 Decimals: ${event.token.decimals}`);
    console.log(`⏰ Timestamp: ${new Date(event.timestamp).toISOString()}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Stats
    const stats = scanner.getStats();
    console.log(`📊 Stats: ${tokensDetected} tokens | Cache: ${stats.cacheSize} pools\n`);
  });

  scanner.on('fastCheck', async (event: MarketEvent) => {
    fastCheckTriggered++;
    console.log('\n⚡⚡⚡ FAST CHECK ACTIVÉ ⚡⚡⚡');
    console.log(`🔥 Liquidité élevée détectée: ${event.initialLiquiditySol.toFixed(2)} SOL`);
    console.log(`🛡️  Lancement du Guard en priorité absolue...\n`);

    try {
      const report = await guard.validateToken(event.token.mint);
      
      console.log('📋 Résultat Guard (FastCheck):');
      console.log(`   - Safe: ${report.isSafe ? '✅' : '❌'}`);
      console.log(`   - Risk Score: ${report.riskScore}/100`);
      console.log(`   - Flags: ${report.flags.join(', ') || 'Aucun'}`);
      
      if (report.isSafe && report.riskScore < 30) {
        console.log('🚀 TOKEN VALIDÉ - PRÊT POUR SNIPE!\n');
      } else {
        console.log('⚠️  Token rejeté par le Guard\n');
      }
    } catch (error) {
      console.error('❌ Erreur lors du Guard check:', error);
    }
  });

  scanner.on('error', (error: Error) => {
    console.error('❌ Erreur du scanner:', error.message);
  });

  scanner.on('disconnected', () => {
    console.log('🛑 Scanner déconnecté');
  });

  // Démarre le scanner
  try {
    await scanner.start();

    // Affiche les stats toutes les 30 secondes
    const statsInterval = setInterval(() => {
      console.log(`\n📊 Stats globales: ${tokensDetected} tokens détectés | ${fastCheckTriggered} FastCheck`);
    }, 30000);

    // Gestion propre de l'arrêt
    process.on('SIGINT', async () => {
      console.log('\n\n🛑 Arrêt demandé...');
      clearInterval(statsInterval);
      await scanner.stop();
      
      console.log('\n📊 Résumé final:');
      console.log(`   - Tokens détectés: ${tokensDetected}`);
      console.log(`   - FastCheck déclenchés: ${fastCheckTriggered}`);
      
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
