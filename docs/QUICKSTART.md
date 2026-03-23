# Quickstart APEX-2026

## Prerequis

- Bun `>= 1.3.11`
- TypeScript `5.9.3`
- Un fichier `.env` derive de `.env.example`

## Installation

```bash
bun install
```

## Configuration minimale

Copiez `.env.example` vers `.env`, puis renseignez les variables dont vous avez besoin.

Variables courantes:

- `RPC_URL`
- `HELIUS_GEYSER_ENDPOINT`
- `HELIUS_API_KEY`
- `WALLET_PRIVATE_KEY`
- `JITO_BLOCK_ENGINE_URL`
- `JITO_AUTH_PRIVATE_KEY`
- `TRADING_ENABLED=false`

## Verifications recommandees

```bash
bun --version
bun install --frozen-lockfile
bun run typecheck
bun run verify
```

## Demarrage

```bash
bun run start
```

## Scripts utiles

```bash
bun scripts/test-guard.ts <MINT_ADDRESS>
bun scripts/test-market-scanner.ts
bun scripts/test-decision-core.ts
```

## Etat reel du runtime

- Le repo passe `bun run typecheck`.
- Le live trading reste desactive par defaut.
- Toute execution live exige `TRADING_ENABLED=true`.
- `src/app.ts` ne doit pas demarrer le chemin d'execution live sans cet opt-in.
- `src/executor/Sniper.ts` bloque aussi `executeSwap()` et `sendJitoBundle()` si `TRADING_ENABLED` n'est pas `true`.

## Compatibilite Jito

- L'integration Jito reste incrementalement isolee.
- `src/executor/Sniper.ts` charge encore dynamiquement `jito-ts/dist/sdk/block-engine/searcher.js` et `jito-ts/dist/sdk/block-engine/types.js`.
- Ce chargement est volontairement documente comme `temporary compatibility shim`.
- Le but est d'eviter que `jito-ts@3.0.1` ne re-casse le typecheck global.

## Limites connues

- Le typecheck vert ne remplace pas une validation end-to-end en conditions reelles.
- Le chemin Jupiter/Jito reste dependant des APIs et SDK externes.
- La documentation historique du projet peut encore sur-promettre la latence ou l'etat d'avancement de certains modules.
