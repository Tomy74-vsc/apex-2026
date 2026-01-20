# APEX-2026 - Architecture Complète

## Point d'Entrée Principal

Le fichier `src/app.ts` est le point d'entrée principal du bot HFT. Il orchestre tous les composants :

```
app.ts
├── SocialPulse (Redis cache)
├── DecisionCore
│   ├── MarketScanner (WebSocket Raydium)
│   └── Guard (Sécurité on-chain)
└── Sniper (Jito + Jupiter)
```

## Utilisation

### 1. Configuration

Créez un fichier `.env` à la racine :

```env
# RPC (OBLIGATOIRE)
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Redis (pour SocialPulse)
REDIS_URL=redis://localhost:6379

# Wallet Trading (OBLIGATOIRE pour trades)
WALLET_PRIVATE_KEY=your_base58_encoded_private_key
JITO_AUTH_PRIVATE_KEY=your_jito_auth_base58_key

# Jito Block Engine
JITO_BLOCK_ENGINE_URL=https://mainnet.block-engine.jito.wtf

# Paramètres Trading
SWAP_AMOUNT_SOL=0.1
SLIPPAGE_BPS=300
MIN_LIQUIDITY=5
MAX_RISK_SCORE=50
```

### 2. Lancement

```bash
# Mode production
bun run src/app.ts

# Ou directement
bun src/app.ts
```

### 3. Arrêt Propre

Appuyez sur **Ctrl+C** pour arrêter proprement :
- Ferme les connexions WebSocket
- Déconnecte Redis
- Affiche les statistiques finales

## Flux de Données

```
1. MarketScanner détecte nouveau pool Raydium
   ↓
2. DecisionCore reçoit l'événement
   ↓
3. Guard analyse la sécurité on-chain
   ↓
4. SocialPulse récupère signaux sociaux (si disponible)
   ↓
5. DecisionCore calcule score final
   ↓
6. Si score ≥ 70 → Émet 'readyToSnipe'
   ↓
7. Sniper exécute swap via Jito + Jupiter
```

## Tableau de Bord

Le tableau de bord s'affiche automatiquement toutes les **60 secondes** avec :

- **Détection** : Tokens détectés, analysés, snipés
- **DecisionCore** : Statistiques de traitement
- **SocialPulse** : Mints trackés, mentions, statut Redis
- **Sniper** : Statut, montant swap, slippage

## Mode Analyse Seulement

Si `WALLET_PRIVATE_KEY` ou `JITO_AUTH_PRIVATE_KEY` ne sont pas configurés, le bot fonctionne en **mode analyse uniquement** :
- ✅ Détecte les nouveaux tokens
- ✅ Analyse la sécurité
- ✅ Calcule les scores
- ❌ N'exécute **PAS** de trades

Utile pour tester sans risquer de capital.

## Gestion des Signaux

Le bot gère proprement :
- **SIGINT** (Ctrl+C) : Arrêt propre
- **SIGTERM** : Arrêt propre
- **Unhandled Rejections** : Log et arrêt
- **Uncaught Exceptions** : Log et arrêt

## Intégration SocialPulse

Le `DecisionCore` récupère automatiquement les signaux sociaux avant de scorer :

```typescript
// Dans DecisionCore.processToken()
const socialSignal = await this.socialPulse.getSignal(token.mint);

// Le score final inclut :
// - Velocity (mentions/30s) : jusqu'à 10 points
// - Trust score : jusqu'à 5 points
// - Sentiment : jusqu'à 5 points
```

## Intégration Sniper

Quand `DecisionCore` émet `readyToSnipe`, le `Sniper` :
1. Récupère une quote Jupiter
2. Crée la transaction de swap
3. Ajoute un tip Jito (dynamique selon priority)
4. Envoie le bundle au Block Engine

Le tip Jito est ajusté automatiquement :
- **HIGH** priority → 0.05 SOL
- **MEDIUM** priority → 0.01 SOL
- **LOW** priority → 0.001 SOL

## Exemple de Sortie

```
╔══════════════════════════════════════════════════════════╗
║         APEX-2026 - Bot HFT Solana                      ║
╚══════════════════════════════════════════════════════════╝

🔌 Connexion à Redis...
✅ Redis connecté

🚀 Démarrage du DecisionCore...
✅ DecisionCore démarré

✅ Bot démarré avec succès!
📊 Tableau de bord mis à jour toutes les 60 secondes
🛑 Appuyez sur Ctrl+C pour arrêter proprement

🆕 Nouveau token détecté!
   Mint: 7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs
   Pool: abc123...
   Liquidité: 150.00 SOL
   Prix: $0.000012

🔍 Analyse sécurité: 7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs
📊 Token scoré: UNKNOWN (score: 85, priority: HIGH)

🎯 PRÊT À SNIPER: UNKNOWN
   Mint: 7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs
   Score: 85
   Priority: HIGH
   Liquidité: 150.00 SOL

[Sniper] 🎯 Exécution swap pour UNKNOWN (HIGH)
[Sniper] 📊 Quote: 0.1 SOL -> 1234567 UNKNOWN
[Sniper] 💰 Jito Tip: 0.0500 SOL
✅ Swap exécuté! Signature: abc123...
   Explorer: https://solscan.io/tx/abc123...

═══════════════════════════════════════════════════════════
📊 TABLEAU DE BORD
═══════════════════════════════════════════════════════════
⏱️  Uptime: 0h 1m 5s

🔍 Détection:
   Tokens détectés: 3
   Tokens analysés: 2
   Tokens snipés: 1

📊 DecisionCore:
   Traités: 2
   Acceptés: 1
   Rejetés: 1
   Taux d'acceptation: 50.00%

📱 SocialPulse:
   Mints trackés: 2
   Mentions totales: 15
   Redis: ✅ Connecté

🎯 Sniper:
   Status: ✅ Actif
   Montant swap: 0.1 SOL
   Slippage: 3%
═══════════════════════════════════════════════════════════
```

## Troubleshooting

### Redis non connecté
- Vérifiez que Redis est démarré : `redis-cli ping`
- Vérifiez `REDIS_URL` dans `.env`

### WebSocket déconnecté
- Vérifiez `HELIUS_WS_URL` (doit commencer par `wss://`)
- Vérifiez votre quota Helius API

### Sniper inactif
- Vérifiez `WALLET_PRIVATE_KEY` et `JITO_AUTH_PRIVATE_KEY`
- Le bot fonctionne en mode analyse uniquement sans ces clés

### Erreur de swap
- Vérifiez le solde du wallet (doit avoir assez de SOL)
- Vérifiez que le slippage est suffisant
- Vérifiez la liquidité du token

## Sécurité

⚠️ **IMPORTANT** :
- Ne commitez **JAMAIS** votre `.env` (déjà dans `.gitignore`)
- Commencez avec de petits montants (`SWAP_AMOUNT_SOL=0.01`)
- Testez en mode analyse d'abord (sans clés wallet)
- Surveillez les logs pour détecter les anomalies

## Performance

- **Latence détection** : < 100ms (WebSocket)
- **Latence analyse** : 200-500ms (Guard + SocialPulse)
- **Latence exécution** : < 200ms (Sniper)
- **Total** : < 1 seconde de la détection au swap

## Roadmap

- [ ] Support multi-wallets (rotation)
- [ ] Circuit breaker (arrêt auto si pertes)
- [ ] Stop-loss automatique
- [ ] Métriques Prometheus
- [ ] Dashboard web (Grafana)
