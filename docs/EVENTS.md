# APEX-2026 - Guide des Événements

## Vue d'Ensemble

Le bot utilise des `EventEmitter` TypeScript pour la communication entre composants. Chaque composant émet des événements que d'autres peuvent écouter.

## MarketScanner Events

### `newToken`

Émis quand un nouveau pool est détecté sur Raydium.

**Type** : `MarketEvent`

```typescript
scanner.on('newToken', (event: MarketEvent) => {
  console.log('Mint:', event.token.mint);
  console.log('Pool:', event.poolId);
  console.log('Liquidité:', event.initialLiquiditySol);
  console.log('Prix:', event.initialPriceUsdc);
  console.log('Timestamp:', event.timestamp);
});
```

**Fréquence** : Variable (dépend de l'activité Raydium)

**Latence** : < 250ms après création du pool

### `fastCheck`

Émis quand la liquidité initiale dépasse le threshold (défaut: 100 SOL).

**Type** : `MarketEvent`

```typescript
scanner.on('fastCheck', async (event: MarketEvent) => {
  console.log('🔥 Haute liquidité:', event.initialLiquiditySol);
  
  // Priorité absolue - déclenche Guard immédiatement
  const report = await guard.validateToken(event.token.mint);
});
```

**Fréquence** : Rare (pools haute liquidité)

**Priorité** : ABSOLUE (court-circuite le pipeline)

### `connected`

Émis quand le WebSocket est connecté.

```typescript
scanner.on('connected', () => {
  console.log('✅ Scanner connecté');
});
```

### `disconnected`

Émis quand le WebSocket est déconnecté.

```typescript
scanner.on('disconnected', () => {
  console.log('🛑 Scanner déconnecté');
});
```

### `error`

Émis en cas d'erreur.

**Type** : `Error`

```typescript
scanner.on('error', (error: Error) => {
  console.error('❌ Erreur:', error.message);
});
```

## DecisionCore Events

### `tokenScored`

Émis après le calcul du score final d'un token.

**Type** : `ScoredToken`

```typescript
core.on('tokenScored', (token: ScoredToken) => {
  console.log('Mint:', token.token.mint);
  console.log('Score final:', token.finalScore);
  console.log('Priorité:', token.priority);
  console.log('Risk score:', token.security.riskScore);
  console.log('Safe:', token.security.isSafe);
});
```

**Fréquence** : Pour chaque token analysé

**Contenu** :
- `MarketEvent` (données du pool)
- `SecurityReport` (analyse Guard)
- `finalScore` (0-100)
- `priority` (HIGH/MEDIUM/LOW)

### `readyToSnipe`

Émis quand un token est validé et prêt pour le trade.

**Type** : `ScoredToken`

```typescript
core.on('readyToSnipe', async (token: ScoredToken) => {
  console.log('🚀 Prêt pour snipe:', token.token.mint);
  console.log('Score:', token.finalScore);
  console.log('Priorité:', token.priority);
  
  // TODO: Appeler le Sniper
  // await sniper.execute(token);
});
```

**Conditions** :
- Score ≥ 70 (standard)
- Score ≥ 60 (FastCheck)
- `isSafe === true`
- Risk score ≤ max configuré

**Fréquence** : 5-10% des tokens détectés

### `tokenRejected`

Émis quand un token est rejeté.

**Paramètres** : `(mint: string, reason: string)`

```typescript
core.on('tokenRejected', (mint: string, reason: string) => {
  console.log('❌ Rejeté:', mint);
  console.log('Raison:', reason);
});
```

**Raisons courantes** :
- "Liquidité insuffisante: X SOL"
- "Risk score trop élevé: X"
- "Token non sûr: FLAGS"
- "Score insuffisant: X"

## Types de Données

### MarketEvent

```typescript
interface MarketEvent {
  token: TokenMetadata;
  poolId: string;
  initialLiquiditySol: number;
  initialPriceUsdc: number;
  timestamp: number;
}
```

### TokenMetadata

```typescript
interface TokenMetadata {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
}
```

### SecurityReport

```typescript
interface SecurityReport {
  mint: string;
  isSafe: boolean;
  riskScore: number; // 0-100
  flags: string[];
  details: {
    mintRenounced: boolean;
    freezeDisabled: boolean;
    lpBurnedPercent: number;
    top10HoldersPercent: number;
    isHoneypot: boolean;
    liquiditySol?: number;
    hasLiquidity?: boolean;
  };
}
```

### ScoredToken

```typescript
interface ScoredToken extends MarketEvent {
  social: SocialSignal | null;
  security: SecurityReport;
  finalScore: number; // 0-100
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
}
```

## Flux d'Événements

### Flux Standard

```
1. MarketScanner.newToken
   ↓
2. DecisionCore traite
   ↓
3. DecisionCore.tokenScored
   ↓
4. Si validé → DecisionCore.readyToSnipe
   Si rejeté → DecisionCore.tokenRejected
```

### Flux FastCheck

```
1. MarketScanner.fastCheck
   ↓
2. DecisionCore traite (priorité)
   ↓
3. DecisionCore.tokenScored
   ↓
4. Si validé (score ≥ 60) → DecisionCore.readyToSnipe
```

## Exemples d'Intégration

### Exemple 1 : Logger Complet

```typescript
import { MarketScanner } from './src/ingestors/MarketScanner';
import { DecisionCore } from './src/engine/DecisionCore';

const scanner = new MarketScanner();
const core = new DecisionCore();

// Logs de connexion
scanner.on('connected', () => console.log('✅ Scanner ON'));
scanner.on('disconnected', () => console.log('🛑 Scanner OFF'));
scanner.on('error', (e) => console.error('❌', e));

// Logs des tokens
core.on('tokenScored', (t) => {
  console.log(`📊 ${t.token.mint}: ${t.finalScore}/100`);
});

core.on('readyToSnipe', (t) => {
  console.log(`🚀 SNIPE: ${t.token.mint}`);
});

core.on('tokenRejected', (mint, reason) => {
  console.log(`❌ ${mint}: ${reason}`);
});

await core.start();
```

### Exemple 2 : Statistiques en Temps Réel

```typescript
let detected = 0;
let scored = 0;
let ready = 0;
let rejected = 0;

scanner.on('newToken', () => detected++);
core.on('tokenScored', () => scored++);
core.on('readyToSnipe', () => ready++);
core.on('tokenRejected', () => rejected++);

setInterval(() => {
  console.log('Stats:');
  console.log(`  Détectés: ${detected}`);
  console.log(`  Scorés: ${scored}`);
  console.log(`  Prêts: ${ready}`);
  console.log(`  Rejetés: ${rejected}`);
  console.log(`  Taux: ${(ready/detected*100).toFixed(2)}%`);
}, 30000);
```

### Exemple 3 : Filtrage Custom

```typescript
core.on('readyToSnipe', async (token) => {
  // Filtre supplémentaire : liquidité > 20 SOL
  if (token.initialLiquiditySol < 20) {
    console.log('Ignoré: liquidité trop faible');
    return;
  }
  
  // Filtre : score > 80 pour priorité HIGH
  if (token.priority === 'HIGH' && token.finalScore < 80) {
    console.log('Ignoré: score insuffisant pour HIGH');
    return;
  }
  
  // OK, on snipe
  await sniper.execute(token);
});
```

### Exemple 4 : Retry sur Erreur

```typescript
scanner.on('error', async (error) => {
  console.error('Erreur scanner:', error);
  
  // Retry après 5 secondes
  await new Promise(r => setTimeout(r, 5000));
  
  console.log('Tentative de reconnexion...');
  await scanner.stop();
  await scanner.start();
});
```

## Bonnes Pratiques

### 1. Toujours Écouter les Erreurs

```typescript
scanner.on('error', (e) => console.error(e));
core.on('error', (e) => console.error(e));
```

### 2. Nettoyer les Listeners

```typescript
process.on('SIGINT', async () => {
  scanner.removeAllListeners();
  core.removeAllListeners();
  await scanner.stop();
  await core.stop();
  process.exit(0);
});
```

### 3. Éviter les Listeners Bloquants

```typescript
// ❌ BAD : Bloque le pipeline
core.on('readyToSnipe', (token) => {
  heavyComputation(); // Bloque
});

// ✅ GOOD : Async non-bloquant
core.on('readyToSnipe', async (token) => {
  await heavyComputation(); // Non-bloquant
});
```

### 4. Limiter le Nombre de Listeners

```typescript
// ❌ BAD : Crée un nouveau listener à chaque fois
function setupListeners() {
  core.on('readyToSnipe', handler); // Leak!
}

// ✅ GOOD : Un seul listener
core.once('readyToSnipe', handler);
// ou
core.on('readyToSnipe', handler);
```

## Debugging

### Afficher Tous les Événements

```typescript
const logEvent = (name: string) => (...args: any[]) => {
  console.log(`[${name}]`, ...args);
};

scanner.on('newToken', logEvent('newToken'));
scanner.on('fastCheck', logEvent('fastCheck'));
scanner.on('connected', logEvent('connected'));
scanner.on('error', logEvent('error'));

core.on('tokenScored', logEvent('tokenScored'));
core.on('readyToSnipe', logEvent('readyToSnipe'));
core.on('tokenRejected', logEvent('tokenRejected'));
```

### Compter les Événements

```typescript
const eventCounts = new Map<string, number>();

const countEvent = (name: string) => () => {
  eventCounts.set(name, (eventCounts.get(name) || 0) + 1);
};

scanner.on('newToken', countEvent('newToken'));
core.on('readyToSnipe', countEvent('readyToSnipe'));

setInterval(() => {
  console.log('Event counts:', Object.fromEntries(eventCounts));
}, 60000);
```

## Référence Rapide

| Événement | Source | Type | Fréquence |
|-----------|--------|------|-----------|
| `newToken` | MarketScanner | MarketEvent | Variable |
| `fastCheck` | MarketScanner | MarketEvent | Rare |
| `connected` | MarketScanner | void | 1x |
| `disconnected` | MarketScanner | void | 1x |
| `error` | MarketScanner/Core | Error | Rare |
| `tokenScored` | DecisionCore | ScoredToken | Fréquent |
| `readyToSnipe` | DecisionCore | ScoredToken | 5-10% |
| `tokenRejected` | DecisionCore | (mint, reason) | 90-95% |
