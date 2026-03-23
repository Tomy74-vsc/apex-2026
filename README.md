# APEX-2026

Bot de trading Solana en Bun/TypeScript, orienté detection rapide, scoring, guard on-chain et execution Jupiter/Jito.

## Etat actuel

- Runtime principal: Bun `>= 1.3.11`
- TypeScript cible: `5.9.3`
- Le repo passe `bun run typecheck`
- Le live trading est desactive par defaut
- Toute execution live exige `TRADING_ENABLED=true` (Sniper **et** CurveExecutor Pump.fun si `TRADING_MODE=live`)

### Pump.fun — collecte `curve-prediction` (mars 2026)

Cinq couches actives dans le code : **on-chain** (poll bonding curve + **flux SOL synthétiques** entre polls pour la vélocité), **microstructure** (GraduationPredictor / snapshots), **whale** (outcomes → `whale_wallets`), **social** (Grok xAI optionnel, Groq, TG ou proxy Dex, DexScreener boosts), **quant** (pGrad, breakeven, vetos, `CurveShadowAgent`). Sorties positions : **rotation ~5 min** par défaut (`TIME_STOP_SECONDS` / `HARD_MAX_HOLD_SECONDS` = 300, voir `ExitEngine` au boot). **Outcomes** → SQLite ; **`bun run export:ml`** → CSV (dont `curve_training_labeled.csv`). Détail et limites : **`COLLECTION_RUNBOOK.md`**.

## Installation

```bash
bun install
```

## Configuration

Copiez `.env.example` vers `.env`, puis renseignez uniquement les secrets necessaires.

Variables importantes:

- `RPC_URL`
- `HELIUS_GEYSER_ENDPOINT`
- `HELIUS_API_KEY`
- `WALLET_PRIVATE_KEY`
- `JITO_BLOCK_ENGINE_URL`
- `JITO_AUTH_PRIVATE_KEY`
- `TRADING_ENABLED=false` par defaut

## Verification rapide

```bash
bun --version
bun install --frozen-lockfile
bun run typecheck
bun run verify
```

## Scripts utiles

- `bun run start`
- `bun run typecheck`
- `bun run verify`
- `bun run verify:xai` — smoke test API xAI (Grok)
- `bun run export:ml` — CSV dataset (`data/`, voir `COLLECTION_RUNBOOK.md`)
- `bun scripts/test-guard.ts <MINT_ADDRESS>`
- `bun scripts/test-market-scanner.ts`
- `bun scripts/test-decision-core.ts`

## Documentation

- [Quickstart](docs/QUICKSTART.md)
- [Architecture](docs/ARCHITECTURE.md)
- [COLLECTION_RUNBOOK.md](COLLECTION_RUNBOOK.md) — collecte ML curve-prediction, export, labels
- [APEX_QUANT_STRATEGY.md](APEX_QUANT_STRATEGY.md) — stratégie quant (rotation, seuils)
- [Guard](src/detectors/README.md)
- [Ingestors](src/ingestors/README.md)

## Notes de securite

- Le repo n'active pas le live trading sans opt-in explicite.
- `src/app.ts` ne doit instancier `Sniper` que si `TRADING_ENABLED=true`.
- `src/executor/Sniper.ts` bloque aussi localement `executeSwap()` et `sendJitoBundle()` si `TRADING_ENABLED` n'est pas `true`.

## Compatibilite restante

- `jito-ts@3.0.1` n'expose pas une API publique stable compatible avec la configuration TypeScript actuelle.
- `src/executor/Sniper.ts` charge encore dynamiquement `jito-ts/dist/sdk/block-engine/searcher.js` et `jito-ts/dist/sdk/block-engine/types.js`.
- Ce choix est volontaire et temporaire: c'est un `temporary compatibility shim` pour isoler Jito sans re-casser le typecheck global.
- Cette integration reste plus fragile qu'un import public supporte par la dependance.

## Honnetete sur l'etat du repo

- La migration de versions a ete stabilisee sans refonte metier.
- Le typecheck est vert, mais cela ne vaut pas validation end-to-end du chemin Jupiter/Jito en conditions reelles.
- Les promesses de latence HFT du projet doivent etre relues a l'aune de l'implementation reelle et des dependances externes.

Created with [Bun](https://bun.sh)
