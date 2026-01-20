# MarketScanner - Surveillance Temps Réel Raydium

## Description

Le `MarketScanner` surveille en temps réel les créations de pools sur Raydium AMM v4 via WebSocket. Il détecte instantanément les nouveaux tokens et émet des événements pour le `DecisionCore`.

## Architecture

```
WebSocket (onLogs)
    ↓
Raydium AMM v4 Program
    ↓
Filtre initialize2
    ↓
getTransaction (maxSupportedTransactionVersion: 0)
    ↓
Parse Pool Data
    ↓
Cache Check (évite doublons)
    ↓
Emit Events → DecisionCore
```

## Fonctionnalités

### 1. Surveillance WebSocket (onLogs)
- ✅ Connexion WebSocket dédiée au programme Raydium AMM v4
- ✅ Filtre automatique sur l'instruction `initialize2`
- ✅ Détection instantanée (< 100ms après la création du pool)

### 2. Extraction des Données
- ✅ `getTransaction` avec `maxSupportedTransactionVersion: 0`
- ✅ Parse du mint token, pool ID, vaults SOL
- ✅ Calcul de la liquidité initiale en SOL
- ✅ Estimation du prix initial

### 3. Cache Local (Optimisation 2026)
- ✅ Map en mémoire pour éviter le double traitement
- ✅ TTL configurable (défaut: 1 heure)
- ✅ Nettoyage automatique toutes les 5 minutes
- ✅ Taille max configurable (défaut: 10,000 pools)

### 4. Mode FastCheck
- ✅ Détection de liquidité élevée (> 100 SOL par défaut)
- ✅ Événement `fastCheck` séparé pour priorité absolue
- ✅ Déclenche le Guard immédiatement

## Événements

### `newToken`
Émis pour chaque nouveau pool détecté.

```typescript
scanner.on('newToken', (event: MarketEvent) => {
  console.log('Nouveau token:', event.token.mint);
  console.log('Liquidité:', event.initialLiquiditySol, 'SOL');
});
```

### `fastCheck`
Émis quand la liquidité initiale dépasse le threshold.

```typescript
scanner.on('fastCheck', async (event: MarketEvent) => {
  // Priorité absolue - déclenche le Guard immédiatement
  const report = await guard.validateToken(event.token.mint);
  
  if (report.isSafe) {
    // Prêt pour snipe!
  }
});
```

### `error`
Émis en cas d'erreur.

```typescript
scanner.on('error', (error: Error) => {
  console.error('Erreur:', error);
});
```

### `connected` / `disconnected`
État de la connexion WebSocket.

## Configuration

```typescript
const scanner = new MarketScanner({
  rpcUrl: 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY',
  wsUrl: 'wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY',
  fastCheckThreshold: 100, // SOL
  cacheSize: 10000,
  cacheTtlMs: 3600000, // 1 heure
});
```

### Variables d'Environnement

```env
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

## Utilisation

### Démarrage

```typescript
import { MarketScanner } from './ingestors/MarketScanner';

const scanner = new MarketScanner();

scanner.on('newToken', (event) => {
  console.log('Nouveau token:', event.token.mint);
});

await scanner.start();
```

### Arrêt

```typescript
await scanner.stop();
```

### Statistiques

```typescript
const stats = scanner.getStats();
console.log('Running:', stats.isRunning);
console.log('Cache size:', stats.cacheSize);
```

## Script de Test

```bash
# Lance le scanner en mode test
bun scripts/test-market-scanner.ts
```

Le script affiche en temps réel :
- Tous les nouveaux pools détectés
- Les FastCheck déclenchés
- Les résultats du Guard pour les pools à haute liquidité

## Intégration avec DecisionCore

```typescript
// Dans DecisionCore.ts
import { MarketScanner } from '../ingestors/MarketScanner';
import { Guard } from '../detectors/Guard';

export class DecisionCore {
  private scanner: MarketScanner;
  private guard: Guard;

  constructor() {
    this.scanner = new MarketScanner();
    this.guard = new Guard();
    
    // Événement standard
    this.scanner.on('newToken', async (event) => {
      await this.analyzeToken(event);
    });
    
    // FastCheck - priorité absolue
    this.scanner.on('fastCheck', async (event) => {
      const report = await this.guard.validateToken(event.token.mint);
      
      if (report.isSafe && report.riskScore < 30) {
        // Déclenche le snipe immédiatement!
        await this.executeSnipe(event, report);
      }
    });
  }

  async start() {
    await this.scanner.start();
  }
}
```

## Performance

### Latence
- Détection WebSocket: **< 100ms** après création du pool
- Parse transaction: **50-150ms**
- Total: **< 250ms** de la création à l'événement

### Optimisations 2026
1. **Cache local** : Évite les requêtes RPC redondantes
2. **WebSocket dédié** : Connexion séparée pour les logs
3. **FastCheck** : Court-circuite le pipeline pour haute liquidité
4. **Nettoyage automatique** : Gestion mémoire optimale

## Raydium AMM v4 - Structure du Pool

### Offsets Importants
- **400-432**: Base Mint (32 bytes)
- **432-464**: Quote Mint (32 bytes)
- **464-496**: Base Vault (32 bytes)
- **496-528**: Quote Vault (32 bytes)
- **528-560**: LP Mint (32 bytes)

### Instruction initialize2
- **Discriminator**: `[0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed]`
- **Program ID**: `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`

## Troubleshooting

### WebSocket se déconnecte
- Vérifiez que `HELIUS_WS_URL` est correct (wss://)
- Helius a des rate limits, utilisez une clé API dédiée

### Pools manqués
- Vérifiez le commitment level (`confirmed` recommandé)
- Augmentez le `cacheTtlMs` si beaucoup de doublons

### Faux positifs
- Ajustez `fastCheckThreshold` selon votre stratégie
- Intégrez le Guard pour filtrer les tokens dangereux

## Roadmap

- [ ] Intégration Metaplex pour nom/symbol réels
- [ ] Support multi-DEX (Orca, Meteora)
- [ ] Oracle prix pour estimation USDC précise
- [ ] Métriques Prometheus/Grafana
- [ ] Reconnexion automatique WebSocket
