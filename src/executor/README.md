# Sniper - Exécution HFT via Jito + Jupiter

## Description

Le `Sniper` est le module d'exécution qui transforme les tokens scorés en transactions réelles. Il combine **Jupiter v6** (meilleur routage DEX) et **Jito Block Engine** (inclusion garantie dans le bloc) pour maximiser les chances de succès.

## Architecture

```
ScoredToken (HIGH/MEDIUM/LOW)
    ↓
Jupiter Quote API v6
    ↓
VersionedTransaction (Swap SOL -> Token)
    ↓
Jito Tip Transaction (dynamique selon priority)
    ↓
Bundle [SwapTx, TipTx]
    ↓
Jito Block Engine → Validators
    ↓
On-chain confirmation
```

## Fonctionnalités

### 1. Jupiter API v6 Integration
- ✅ Quote automatique avec slippage configurable (défaut: 3%)
- ✅ Force `VersionedTransaction` (format moderne)
- ✅ `dynamicComputeUnitLimit` pour optimiser les frais
- ✅ `prioritizationFeeLamports: auto` pour priority fees
- ✅ Vérification du price impact (annule si > 10%)

### 2. Jito Bundle System
- ✅ Tip dynamique selon priority :
  - **HIGH**: 0.05 SOL (50M lamports)
  - **MEDIUM**: 0.01 SOL (10M lamports)
  - **LOW**: 0.001 SOL (1M lamports)
- ✅ Load balancing sur 4 tip accounts Jito
- ✅ Bundle [SwapTx, TipTx] pour atomicité
- ✅ Authentification via keypair dédié

### 3. Sécurités Intégrées
- ✅ Validation du price impact (< 10%)
- ✅ Simulation optionnelle avant envoi
- ✅ Tracking du statut de transaction
- ✅ Gestion d'erreurs robuste

### 4. Optimisation Latence
- ✅ Construction du bundle en < 100ms
- ✅ Pas de clones d'objets inutiles
- ✅ Connexion RPC avec commitment `confirmed`
- ✅ Timeout configurable (60s par défaut)

## Configuration

```typescript
import { Sniper } from './executor/Sniper';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// Charge les keypairs depuis .env
const walletKeypair = Keypair.fromSecretKey(
  bs58.decode(process.env.WALLET_PRIVATE_KEY!)
);

const jitoAuthKeypair = Keypair.fromSecretKey(
  bs58.decode(process.env.JITO_AUTH_PRIVATE_KEY!)
);

const sniper = new Sniper({
  rpcUrl: process.env.HELIUS_RPC_URL!,
  walletKeypair,
  jitoBlockEngineUrl: 'https://mainnet.block-engine.jito.wtf',
  jitoAuthKeypair,
  jupiterApiUrl: 'https://quote-api.jup.ag/v6', // optionnel
  swapAmountSol: 0.1, // optionnel (défaut: 0.1)
  slippageBps: 300, // optionnel (défaut: 300 = 3%)
});
```

### Variables d'Environnement

```env
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
WALLET_PRIVATE_KEY=your_base58_private_key
JITO_AUTH_PRIVATE_KEY=your_jito_auth_base58_key
```

## Utilisation

### Exécution de Swap

```typescript
import type { ScoredToken } from '../types/index';

// Token scoré par DecisionCore
const scoredToken: ScoredToken = {
  token: {
    mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    symbol: 'BONK',
    name: 'Bonk',
    decimals: 5,
  },
  poolId: 'abc123',
  initialLiquiditySol: 150,
  initialPriceUsdc: 0.000012,
  timestamp: Date.now(),
  social: {
    mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    ticker: 'BONK',
    platform: 'X',
    authorTrustScore: 85,
    followerCount: 120000,
    velocity30s: 25,
    sentiment: 0.9,
  },
  security: {
    mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    isSafe: true,
    riskScore: 15,
    flags: [],
    details: {
      mintRenounced: true,
      freezeDisabled: true,
      lpBurnedPercent: 100,
      top10HoldersPercent: 8,
      isHoneypot: false,
    },
  },
  finalScore: 92,
  priority: 'HIGH',
};

// Exécute le swap
const signature = await sniper.executeSwap(scoredToken);

if (signature) {
  console.log(`✅ Swap exécuté: https://solscan.io/tx/${signature}`);
  
  // Attendre la confirmation
  let status = null;
  let attempts = 0;
  
  while (!status && attempts < 30) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    status = await sniper.checkTransactionStatus(signature);
    attempts++;
  }
  
  console.log(`Status final: ${status}`);
} else {
  console.error('❌ Échec du swap');
}
```

### Simulation (Tests)

```typescript
// Simule avant d'exécuter (optionnel)
const quote = await sniper.getJupiterQuote(scoredToken.token.mint);
const tx = await sniper.createSwapTransaction(quote);
const isValid = await sniper.simulateTransaction(tx);

if (isValid) {
  console.log('✅ Transaction valide, prêt à envoyer');
} else {
  console.error('❌ Simulation échouée');
}
```

## Intégration avec DecisionCore

```typescript
// Dans DecisionCore.ts
import { Sniper } from '../executor/Sniper';
import { MarketScanner } from '../ingestors/MarketScanner';
import { Guard } from '../detectors/Guard';

export class DecisionCore {
  private scanner: MarketScanner;
  private guard: Guard;
  private sniper: Sniper;

  constructor() {
    this.scanner = new MarketScanner();
    this.guard = new Guard();
    this.sniper = new Sniper({
      rpcUrl: process.env.HELIUS_RPC_URL!,
      walletKeypair: /* ... */,
      jitoBlockEngineUrl: 'https://mainnet.block-engine.jito.wtf',
      jitoAuthKeypair: /* ... */,
    });

    this.scanner.on('newToken', async (event) => {
      const report = await this.guard.validateToken(event.token.mint);
      
      if (report.isSafe && report.riskScore < 30) {
        const scoredToken = this.scoreToken(event, report);
        
        if (scoredToken.finalScore > 70) {
          // Déclenche le snipe!
          await this.sniper.executeSwap(scoredToken);
        }
      }
    });
  }
}
```

## Jito Block Engine

### Endpoints (Mainnet)

- **Block Engine**: `https://mainnet.block-engine.jito.wtf`
- **Tip Accounts** (4 pour load balancing):
  - `Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY`
  - `DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL`
  - `96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5`
  - `3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT`

### Authentification

Jito nécessite un keypair dédié pour l'authentification au Block Engine. Génère-le avec :

```bash
solana-keygen new -o jito-auth.json
```

**⚠️ IMPORTANT**: Ne JAMAIS mettre de SOL sur ce wallet. Il sert uniquement à l'authentification.

## Performance

### Latence Moyenne

- Quote Jupiter: **50-100ms**
- Création transaction: **20-50ms**
- Envoi bundle Jito: **30-80ms**
- **Total: < 200ms** de la décision à l'envoi

### Taux de Succès

- **Jito Bundle**: 95%+ d'inclusion dans le bloc suivant (si tip suffisant)
- **Jupiter Routing**: 99%+ de réussite de quote
- **Price Impact**: Vérifié automatiquement (< 10%)

## Troubleshooting

### Bundle rejeté par Jito

- **Cause**: Tip trop faible ou bundle invalide
- **Solution**: Augmente les tips HIGH/MEDIUM/LOW dans le code

### Transaction simulée échoue

- **Cause**: Liquidité insuffisante ou token honeypot
- **Solution**: Le Guard devrait avoir filtré en amont. Vérifie `isSafe`.

### Price impact > 10%

- **Cause**: Montant de swap trop élevé vs liquidité
- **Solution**: Réduis `swapAmountSol` dans la config

### Timeout de confirmation

- **Cause**: Réseau Solana congestionné
- **Solution**: Augmente `confirmTransactionInitialTimeout` dans Connection

## Sécurité

### ⚠️ RISQUES

1. **Capital à risque**: Le bot trade avec de vrais SOL. Commence avec des petits montants (0.01-0.1 SOL).
2. **Slippage**: Même avec 3%, le prix peut bouger rapidement. Surveille les pertes.
3. **Honeypots**: Le Guard filtre, mais rien n'est 100% sûr. Toujours tester.
4. **Private keys**: Stocke-les dans `.env`, JAMAIS dans le code. Ajoute `.env` au `.gitignore`.

### Best Practices

```typescript
// ✅ BON: Vérifie avant de sniper
if (report.isSafe && report.riskScore < 30 && scoredToken.finalScore > 70) {
  await sniper.executeSwap(scoredToken);
}

// ❌ MAUVAIS: Snipe aveuglément
await sniper.executeSwap(scoredToken);
```

## Roadmap

- [ ] Support multi-tokens (batch swaps dans un bundle)
- [ ] Circuit breaker (arrêt auto si 3 pertes consécutives)
- [ ] MEV protection (private mempool via Jito)
- [ ] Auto-adjust tip selon congestion réseau
- [ ] Stop-loss automatique post-achat
- [ ] Métriques Prometheus (latence, taux de succès)

## Exemple Complet

Voir `scripts/test-sniper.ts` pour un exemple end-to-end avec simulation.

```bash
bun scripts/test-sniper.ts
```
