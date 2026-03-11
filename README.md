# APEX-2026 - Bot Trading HFT Solana

Bot de trading haute fréquence (HFT) pour Solana, spécialisé dans la détection et l'analyse instantanée de nouveaux tokens sur Raydium AMM v4.

## 🚀 Fonctionnalités

- ⚡ **Détection temps réel** : WebSocket sur Raydium (< 100ms)
- 🛡️ **Analyse sécurité** : Guard avec vérification complète (autorités, liquidité, honeypot)
- 🎯 **Scoring intelligent** : DecisionCore avec score 0-100
- 🔥 **FastCheck** : Priorité absolue pour haute liquidité (> 100 SOL)
- 💾 **Cache optimisé** : Évite les doublons (Map locale)
- 📊 **Pipeline complet** : Scanner → Guard → Scoring → Sniper (TODO)

## 📦 Installation

```bash
bun install
```

## ⚙️ Configuration

Créez un fichier `.env` :

```env
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

## 🧪 Tests

```bash
# Test Guard (analyse sécurité)
bun scripts/test-guard.ts <MINT_ADDRESS>

# Test MarketScanner (détection temps réel)
bun scripts/test-market-scanner.ts

# Test Pipeline complet
bun scripts/test-decision-core.ts
```

## 📚 Documentation

- [Guide de Démarrage Rapide](docs/QUICKSTART.md)
- [Architecture Complète](docs/ARCHITECTURE.md)
- [Guard README](src/detectors/README.md)
- [MarketScanner README](src/ingestors/README.md)

## Runtime et versions cibles

- **Runtime principal** : Bun `1.3.10`
- **TypeScript** : `5.9.3`
- **Politique de versions** : pas de Bun 2.x, pas de TypeScript 6 RC sur la branche principale

## Vérification rapide

```bash
bun --version
bun install --frozen-lockfile
bun run typecheck
```

## 🏗️ Architecture

```
MarketScanner (WebSocket) → DecisionCore → Guard → Sniper (TODO)
     ↓                           ↓            ↓
  newToken                   Scoring      Security
  fastCheck                  0-100        Analysis
```

## 🎯 Roadmap

- [x] MarketScanner avec WebSocket onLogs
- [x] Guard avec analyse complète
- [x] DecisionCore avec scoring
- [x] FastCheck pour haute liquidité
- [ ] Sniper avec Jito + Jupiter
- [ ] Social signals (X/Twitter)
- [ ] Dashboard monitoring

## 🔧 Stack Technique

- **Runtime** : Bun `1.3.10`
- **Langage** : TypeScript `5.9.3`
- **Blockchain** : Solana (@solana/web3.js, @solana/spl-token)
- **DEX** : Raydium AMM v4, Jupiter v6
- **MEV** : Jito Block Engine (TODO)

## État honnête de la migration

- Le repo reste basé sur Bun comme runtime principal.
- Les versions critiques sont désormais destinées à être figées et reproductibles.
- La migration de versions ne garantit pas à elle seule un typecheck vert.
- Si certaines dépendances restent incompatibles avec Bun `1.3.10` ou TypeScript `5.9.3`, elles doivent être traitées séparément, sans bricolage métier.
- Le live trading reste désactivé par défaut et nécessite `TRADING_ENABLED=true`.

## Incompatibilités restantes connues

- `jito-ts@3.0.1` reste incompatible avec le typecheck actuel sous `verbatimModuleSyntax` et TypeScript `5.9.3`.
- Le code applicatif a encore des erreurs de typage dans `src/detectors/Guard.ts`.
- `bs58` a une version majeure stable plus récente, mais elle n'a pas été adoptée dans cette migration afin de conserver une montée de version sûre et limitée.

## 📊 Performance

- Latence détection : **< 100ms**
- Pipeline complet : **2-5s** (standard), **1-3s** (FastCheck)
- Throughput : **~50 tokens/minute**

---

Créé avec [Bun](https://bun.com) 🚀
