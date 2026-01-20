#!/usr/bin/env bun
/**
 * Script de test pour la classe Guard
 * 
 * Usage: bun scripts/test-guard.ts <MINT_ADDRESS>
 */

import { Guard } from '../src/detectors/Guard';

async function main() {
  const mintAddress = process.argv[2];

  if (!mintAddress) {
    console.error('Usage: bun scripts/test-guard.ts <MINT_ADDRESS>');
    console.error('Exemple: bun scripts/test-guard.ts So11111111111111111111111111111111111111112');
    process.exit(1);
  }

  console.log('🛡️  Guard - Analyse de sécurité on-chain\n');
  console.log(`Token: ${mintAddress}\n`);

  try {
    const guard = new Guard();
    
    console.log('⏳ Analyse en cours...\n');
    const report = await guard.validateToken(mintAddress);

    console.log('📊 Résultats:\n');
    console.log(`✅ Sûr: ${report.isSafe ? 'OUI' : 'NON'}`);
    console.log(`⚠️  Score de risque: ${report.riskScore}/100\n`);

    console.log('📋 Détails:');
    console.log(`  - Mint Authority révoquée: ${report.details.mintRenounced ? '✅' : '❌'}`);
    console.log(`  - Freeze Authority désactivée: ${report.details.freezeDisabled ? '✅' : '❌'}`);
    console.log(`  - Top 10 holders: ${report.details.top10HoldersPercent.toFixed(2)}%`);
    console.log(`  - Honeypot détecté: ${report.details.isHoneypot ? '❌' : '✅'}`);
    console.log(`  - Pool de liquidité: ${report.details.hasLiquidity ? '✅' : '❌'}`);
    
    if (report.details.liquiditySol !== undefined) {
      console.log(`  - Liquidité SOL: ${report.details.liquiditySol.toFixed(2)} SOL`);
    }
    
    console.log(`  - LP brûlé: ${report.details.lpBurnedPercent.toFixed(2)}%`);

    if (report.flags.length > 0) {
      console.log('\n🚩 Flags de sécurité:');
      report.flags.forEach(flag => console.log(`  - ${flag}`));
    }

    console.log('\n✅ Analyse terminée');
  } catch (error) {
    console.error('❌ Erreur lors de l\'analyse:', error);
    process.exit(1);
  }
}

main();
