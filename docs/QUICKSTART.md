# APEX-2026 - Guide de Démarrage Rapide

## Installation

### 1. Prérequis
- **Bun** `1.3.10` (runtime principal, pas de Node.js)
- **TypeScript** `5.9.3` (installé via dépendances de dev du repo)
- **Clé API Helius** avec WebSocket support
- **Solana Mainnet** access

### 2. Installation des dépendances

```bash
cd "c:\Users\tomre\bot trading"
bun install
bun --version
bun run typecheck
```

### 3. Configuration

Créez un fichier `.env` à la racine :

```env
# Helius RPC (OBLIGATOIRE)
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY

# Helius WebSocket (OBLIGATOIRE)
HELIUS_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY

# Jito (optionnel pour l'instant)
# JITO_BLOCK_ENGINE_URL=https://mainnet.block-engine.jito.wtf
```

⚠️ **Important** : Remplacez `YOUR_API_KEY` par votre vraie clé Helius.

### État de compilation

Cette migration vise des versions stables et reproductibles de Bun et TypeScript.
Elle ne promet pas qu'un typecheck rouge existant devient vert si le blocage vient du code applicatif ou d'une dépendance tierce.

### Incompatibilités connues après migration

- `jito-ts@3.0.1` provoque encore des erreurs TypeScript avec la configuration actuelle.
- `src/detectors/Guard.ts` contient encore des erreurs de typage applicatives.
- Le runtime cible documenté est `Bun 1.3.10`, mais les vérifications locales restent dépendantes de la version Bun effectivement installée sur la machine.

### Sécurité d'exécution

Le live trading est désactivé par défaut.
Pour autoriser l'exécution réelle, il faut définir explicitement `TRADING_ENABLED=true` dans `.env`.

## Tests Individuels

### Test 1 : Guard (Analyse de Sécurité)

Teste l'analyse d'un token existant :

```bash
bun scripts/test-guard.ts So11111111111111111111111111111111111111112
```

**Résultat attendu** :
```
🛡️  Guard - Analyse de sécurité on-chain

Token: So11111111111111111111111111111111111111112

⏳ Analyse en cours...

📊 Résultats:
✅ Sûr: OUI
⚠️  Score de risque: 0/100

📋 Détails:
  - Mint Authority révoquée: ✅
  - Freeze Authority désactivée: ✅
  - Top 10 holders: 45.23%
  - Honeypot détecté: ✅
  - Pool de liquidité: ✅
  - Liquidité SOL: 1234.56 SOL
  - LP brûlé: 0.00%

✅ Analyse terminée
```

### Test 2 : MarketScanner (Détection Temps Réel)

Lance la surveillance des nouveaux pools Raydium :

```bash
bun scripts/test-market-scanner.ts
```

**Résultat attendu** :
```
🚀 Test du MarketScanner - Surveillance Raydium AMM v4

🚀 Démarrage du MarketScanner...
📊 Programme surveillé: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
⚡ FastCheck threshold: 100 SOL
✅ MarketScanner connecté et en écoute

⏳ En attente de nouveaux pools...

[Attend qu'un nouveau pool soit créé sur Raydium]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🆕 NOUVEAU TOKEN DÉTECTÉ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 Mint: ABC123...
🏊 Pool ID: XYZ789...
💧 Liquidité: 45.23 SOL
💰 Prix initial: $0.000123
🔢 Decimals: 9
⏰ Timestamp: 2026-01-19T...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Arrêt** : `Ctrl+C`

### Test 3 : Pipeline Complet (DecisionCore)

Lance le bot complet (Scanner → Guard → Scoring) :

```bash
bun scripts/test-decision-core.ts
```

**Résultat attendu** :
```
🚀 Test du DecisionCore - Pipeline Complet

📊 MarketScanner → Guard → DecisionCore → Sniper

🚀 Démarrage du DecisionCore...
   - Liquidité min: 5 SOL
   - Risk score max: 50
   - FastCheck: Activé

✅ DecisionCore: Scanner connecté

[Attend détection de pools]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 TOKEN SCORÉ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 Mint: ABC123...
🏊 Pool: XYZ789...
💧 Liquidité: 45.23 SOL
🎯 Score Final: 75/100
⚡ Priorité: HIGH
🛡️  Risk Score: 25/100
✅ Safe: OUI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🚀🚀🚀 READY TO SNIPE 🚀🚀🚀
🎯 Token: ABC123...
💰 Liquidité: 45.23 SOL
📈 Score: 75/100
⚡ Priorité: HIGH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Arrêt** : `Ctrl+C`

## Utilisation Programmatique

### Exemple 1 : Scanner Simple

```typescript
import { MarketScanner } from './src/ingestors/MarketScanner';

const scanner = new MarketScanner();

scanner.on('newToken', (event) => {
  console.log('Nouveau token:', event.token.mint);
  console.log('Liquidité:', event.initialLiquiditySol, 'SOL');
});

await scanner.start();
```

### Exemple 2 : Guard Standalone

```typescript
import { Guard } from './src/detectors/Guard';

const guard = new Guard();
const report = await guard.validateToken('MINT_ADDRESS');

if (report.isSafe && report.riskScore < 50) {
  console.log('Token validé!');
} else {
  console.log('Token rejeté:', report.flags);
}
```

### Exemple 3 : DecisionCore Complet

```typescript
import { DecisionCore } from './src/engine/DecisionCore';

const core = new DecisionCore({
  minLiquidity: 10,      // 10 SOL min
  maxRiskScore: 40,      // Risk max 40
  fastCheckThreshold: 150, // FastCheck à 150 SOL
});

core.on('readyToSnipe', async (token) => {
  console.log('Prêt pour snipe:', token.token.mint);
  // TODO: Appeler le Sniper
});

await core.start();
```

## Troubleshooting

### Erreur : "invalid api key provided"

**Cause** : Clé API Helius manquante ou invalide

**Solution** :
1. Vérifiez votre fichier `.env`
2. Assurez-vous que `HELIUS_RPC_URL` contient votre clé API
3. Testez la clé sur https://docs.helius.dev

### Erreur : WebSocket se déconnecte

**Cause** : Rate limit Helius ou connexion instable

**Solution** :
1. Utilisez une clé API dédiée (pas partagée)
2. Vérifiez votre plan Helius (Free vs Pro)
3. Ajoutez un retry logic (TODO)

### Aucun pool détecté

**Cause** : Peu de pools créés sur Raydium actuellement

**Solution** :
1. Attendez quelques minutes (pools créés par vagues)
2. Vérifiez que le WebSocket est connecté (`connected` event)
3. Testez sur devnet si nécessaire (TODO)

### Guard trop lent

**Cause** : RPC Helius surchargé ou rate limited

**Solution** :
1. Upgradez votre plan Helius (plus de RPS)
2. Ajoutez un cache Redis (TODO)
3. Réduisez `fastCheckThreshold` pour prioriser

## Prochaines Étapes

1. ✅ **Tester le pipeline** : Lancez `test-decision-core.ts` et observez
2. ⏳ **Implémenter le Sniper** : Intégration Jito + Jupiter (TODO)
3. ⏳ **Ajouter social signals** : X/Twitter monitoring (TODO)
4. ⏳ **Déployer en prod** : VPS avec monitoring (TODO)

## Ressources

- **Architecture** : `/docs/ARCHITECTURE.md`
- **Guard README** : `/src/detectors/README.md`
- **MarketScanner README** : `/src/ingestors/README.md`
- **Types** : `/src/types/index.ts`

## Support

En cas de problème :
1. Vérifiez les logs (emojis + timestamps)
2. Consultez les README des composants
3. Testez chaque composant individuellement
4. Vérifiez votre configuration `.env`

---

**Bon trading! 🚀**
