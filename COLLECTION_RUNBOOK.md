# APEX-2026 — Machine de collecte (mars 2026)

Objectif : **5 couches** prêtes pour l’entraînement ML — on-chain (courbe + trades), microstructure (bot/velocity/wallets), **whale** (`whale_wallets` + SmartMoney), **social** (Grok X + Narrative optionnels ; **Telegram live ou proxy Dex gratuit** ; DexScreener boosts), **scoring quant** (GraduationPredictor + `curve_snapshots`).

## Infra « guérilla » ($0 / mois cœur)

| Source | Rôle |
|--------|------|
| RPC / WS Solana (public + free tiers Helius/QN si configurés) | Courbe + exécution paper |
| **DexScreener** (HTTP, sans clé) | Boosts, profil token, **proxy social TG** si pas de GramJS |
| **Groq** (`GROQ_API_KEY`, free tier) | NLPPipeline (sentiment messages TG) |
| **xAI** (`XAI_API_KEY`) | Grok X Search + NarrativeRadar — **optionnel** |
| **Telegram** (`TELEGRAM_API_*` + session) | Live channel scan — **optionnel** ; sans ça le bot utilise le **dex_proxy** |

## Sorties & rotation

Référence unique : **`APEX_QUANT_STRATEGY.md` §0** — profil **Rotation** (`TIME_STOP_SECONDS` / `HARD_MAX_HOLD_SECONDS` **300**, stall agressif).

## Ce qui est écrit en base

- `curve_snapshots` : un snapshot par poll **HOT** (features + `social_score`).
- `curve_outcomes` : graduation + évictions (snap **avant** delete dans `TieredMonitor`).
- `open_curve_positions` : positions paper persistées (option env).
- `whale_wallets` : stats enrichies sur outcomes.

## Export CSV (dataset)

```bash
bun run export:ml
```

Fichiers sous `data/` : `curve_snapshots.csv`, `curve_outcomes.csv`, `open_curve_positions.csv` (si présent), `whale_wallets.csv` (si présent), `paper_trades.csv` (depuis `paper_trades.jsonl`).

## Préparer l’entraînement

1. Laisser tourner **24–48 h** en `TRADING_MODE=paper`, `STRATEGY_MODE=curve-prediction`.
2. Vérifier que **Outcomes** et le nombre de **snapshots** augmentent (dashboard / SQLite).
3. Lancer `bun run export:ml` puis importer les CSV dans ton pipeline Python / notebooks.
