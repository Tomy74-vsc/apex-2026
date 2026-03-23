/**
 * scripts/telegram-auth.ts — APEX-2026
 * 
 * Script STANDALONE pour générer la TELEGRAM_SESSION_STRING.
 * À exécuter UNE SEULE FOIS, SÉPARÉMENT du bot.
 * 
 * Usage :
 *   bun scripts/telegram-auth.ts
 * 
 * Prérequis :
 *   - TELEGRAM_API_ID et TELEGRAM_API_HASH dans .env
 *   - Obtenir sur https://my.telegram.org → API development tools
 * 
 * Le script va :
 *   1. Te demander ton numéro de téléphone
 *   2. Telegram t'envoie un code SMS
 *   3. Tu entres le code
 *   4. Si 2FA activé → te demande le mot de passe
 *   5. Affiche la SESSION_STRING à copier dans .env
 * 
 * Après ça, le bot utilisera la session string et ne demandera PLUS JAMAIS
 * le numéro de téléphone.
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Logger } from 'telegram/extensions/Logger.js';
import * as readline from 'readline';

// Désactiver les logs verbeux de GramJS
Logger.setLevel('error');

// Charger les variables d'environnement
const apiId = parseInt(process.env.TELEGRAM_API_ID ?? '0');
const apiHash = process.env.TELEGRAM_API_HASH ?? '';

if (!apiId || !apiHash) {
  console.error('');
  console.error('❌ TELEGRAM_API_ID et TELEGRAM_API_HASH doivent être dans .env');
  console.error('');
  console.error('   Pour les obtenir :');
  console.error('   1. Va sur https://my.telegram.org');
  console.error('   2. Connecte-toi avec ton numéro');
  console.error('   3. Clique sur "API development tools"');
  console.error('   4. Crée une application si pas encore fait');
  console.error('   5. Copie api_id et api_hash dans ton .env :');
  console.error('');
  console.error('   TELEGRAM_API_ID=12345678');
  console.error('   TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890');
  console.error('');
  process.exit(1);
}

// Helper pour lire l'input utilisateur
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('   APEX-2026 — Connexion Telegram (une seule fois)');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log('Ce script génère ta session string Telegram.');
  console.log('Après ça, le bot se connectera automatiquement');
  console.log('sans jamais redemander le numéro.');
  console.log('');

  // Créer un client avec une session vide
  const session = new StringSession('');
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    retryDelay: 1000,
  });

  // Authentification interactive — RIEN D'AUTRE NE TOURNE EN PARALLÈLE
  await client.start({
    phoneNumber: async () => {
      console.log('');
      return await prompt('📱 Ton numéro de téléphone (format international, ex: +33612345678) : ');
    },
    phoneCode: async () => {
      console.log('');
      console.log('📨 Un code vient d\'être envoyé sur ton Telegram.');
      return await prompt('🔑 Entre le code reçu : ');
    },
    password: async () => {
      console.log('');
      console.log('🔐 Ton compte a la vérification 2FA activée.');
      return await prompt('🔑 Entre ton mot de passe 2FA : ');
    },
    onError: (err) => {
      console.error('❌ Erreur :', err.message);
    },
  });

  // Récupérer la session string
  const sessionString = (client.session as StringSession).save();

  console.log('');
  console.log('✅ Connecté avec succès !');
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('   COPIE CETTE LIGNE DANS TON .env :');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log(`TELEGRAM_SESSION_STRING=${sessionString}`);
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log('Maintenant tu peux lancer le bot normalement avec :');
  console.log('  bun run start');
  console.log('');
  console.log('TelegramPulse se connectera automatiquement avec');
  console.log('cette session string. Plus besoin de rentrer le');
  console.log('numéro de téléphone.');
  console.log('');

  // Déconnecter proprement
  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Erreur fatale :', err);
  process.exit(1);
});