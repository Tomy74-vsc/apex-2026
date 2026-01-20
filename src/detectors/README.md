# Guard - Analyseur de Sécurité On-Chain

## Description

La classe `Guard` est un analyseur de sécurité complet pour les tokens Solana. Elle vérifie plusieurs aspects critiques avant d'autoriser un trade.

## Fonctionnalités

### 1. Validation des Autorités (`validateToken`)
- ✅ Vérifie si `mintAuthority` est révoquée (null)
- ✅ Vérifie si `freezeAuthority` est désactivée (null)
- ✅ Utilise `getMint()` de `@solana/spl-token` pour récupérer les Account Info

### 2. Vérification de Liquidité Raydium AMM v4
- ✅ Recherche les pools Raydium contenant le token
- ✅ Récupère le solde du vault SOL du pool
- ✅ Détecte l'absence de liquidité ou liquidité insuffisante (< 5 SOL)

### 3. Détection de Honeypot
- ✅ Utilise Jupiter API pour créer une quote de swap
- ✅ Simule la transaction avec `connection.simulateTransaction()`
- ✅ Analyse les logs pour détecter les erreurs de transfert

### 4. Analyse de Distribution
- ✅ Calcule le pourcentage détenu par les top 10 holders
- ✅ Détecte la concentration excessive (> 50%)

### 5. Calcul du LP Burned
- ✅ Vérifie si les LP tokens sont dans des adresses de burn
- ✅ Calcule le pourcentage brûlé

## Score de Risque (0-100)

Le `riskScore` est calculé selon les règles suivantes :

| Condition | Points |
|-----------|--------|
| Freeze Authority non révoquée | +50 |
| Top 10 holders > 50% | +30 |
| Honeypot détecté | +100 |
| Pas de pool de liquidité | +40 |
| Liquidité < 5 SOL | +20 |

**Score < 50** = Token considéré comme sûr (si toutes les conditions de base sont remplies)

## Utilisation

```typescript
import { Guard } from './detectors/Guard';

const guard = new Guard();

// Valider un token
const report = await guard.validateToken('MINT_ADDRESS');

console.log('Safe:', report.isSafe);
console.log('Risk Score:', report.riskScore);
console.log('Flags:', report.flags);
console.log('Details:', report.details);
```

## Script de Test

```bash
# Tester un token spécifique
bun scripts/test-guard.ts <MINT_ADDRESS>

# Exemple avec SOL
bun scripts/test-guard.ts So11111111111111111111111111111111111111112
```

## Configuration

Assurez-vous d'avoir configuré votre RPC Helius dans `.env` :

```env
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY
```

## Flags de Sécurité

- `MINT_AUTHORITY_NOT_RENOUNCED` - L'autorité de mint n'est pas révoquée
- `FREEZE_AUTHORITY_NOT_DISABLED` - L'autorité de freeze n'est pas désactivée
- `HIGH_CONCENTRATION` - Les top 10 holders détiennent > 50%
- `HONEYPOT_DETECTED` - Le swap simulé a échoué
- `NO_LIQUIDITY_POOL` - Aucun pool de liquidité trouvé
- `LOW_LIQUIDITY` - Liquidité < 5 SOL

## Architecture

```
Guard
├── validateToken()          → Point d'entrée principal
├── analyzeToken()           → Analyse complète
├── checkRaydiumLiquidity()  → Vérifie liquidité Raydium AMM v4
├── detectHoneypot()         → Simule un swap via Jupiter
├── calculateTop10Holders()  → Analyse distribution
└── calculateLPBurned()      → Vérifie LP tokens brûlés
```

## Notes Importantes

⚠️ **Latence** : L'analyse complète peut prendre 2-5 secondes selon la charge RPC.

⚠️ **Rate Limits** : Jupiter API a des rate limits. Pour HFT, considérez un cache Redis.

⚠️ **Faux Positifs** : Les nouveaux tokens peuvent être marqués comme risqués (pas de liquidité encore).

## Intégration avec le Bot

```typescript
// Dans DecisionCore.ts
const guard = new Guard();
const security = await guard.validateToken(token.mint);

if (!security.isSafe || security.riskScore > 50) {
  console.log('Token rejeté:', security.flags);
  return null; // Ne pas trader
}
```
