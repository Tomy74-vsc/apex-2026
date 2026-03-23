# APEX-2026 — Machine de collecte (mars 2026)

Objectif : **machine de collecte Pump.fun** (mars 2026) — **5 couches** alignées données ML : on-chain (état courbe + **flux SOL agrégés** entre polls), microstructure (vélocité / bot / wallets), **whale**, **social** (X + TG + DexScreener), **quant** (pGrad, breakeven, vetos). **Rotation agressive** 5 min (`TIME_STOP` / `HARD_MAX` 300 s), **outcomes** persistés, **CSV** via `bun run export:ml`.

## Les 5 couches (état implémentation)

| # | Couche | Fichiers / flux | Export / labels |
|---|--------|-----------------|-----------------|
| 1 | **On-chain** | `CurveTracker`, `BatchPoller`, `PumpScanner`, decode bonding curve | `curve_snapshots` + **événements `syntheticTrade`** (Δ `realSolReserves` / poll → `recordTrade`) |
| 2 | **Microstructure** | `VelocityAnalyzer` (**utilise aussi trades synthétiques** pour SOL/min), `BotDetector` / `WalletScorer` (**uniquement txs non-`synthetic`** pour wallets) | colonnes vélocité / bot / wallets dans snapshots |
| 3 | **Whale** | `WhaleWalletDB`, `SmartMoneyTracker`, enrichissement sur `curve_outcomes` | `whale_wallets.csv` |
| 4 | **Social** | **xAI** `GrokXScanner` + `NarrativeRadar` (`search_parameters` live X/web), **Groq** NLP (`NLPPipeline`), **TG** `TelegramTokenScanner` (ou `dex_proxy`), **DexScreener** `SocialTrendScanner` | `social_score` agrégé (`SentimentAggregator`) |
| 5 | **Quant** | `GraduationPredictor`, `AIBrain.decideCurve`, `EntryFilter`, `Guard` | `p_grad`, `action`, `breakeven`, vetos |

## Infra « guérilla » + optionnel payant

| Source | Rôle |
|--------|------|
| RPC / WS Solana (**Helius free tier** recommandé : même clé ; + public en secours si besoin) | Courbe + exécution paper |
| **DexScreener** (HTTP, sans clé) | Boosts, profil token, **proxy social TG** si pas de GramJS |
| **Groq** (`GROQ_API_KEY`, free tier) | NLPPipeline (sentiment texte TG) |
| **xAI** (`XAI_API_KEY`) | Grok Responses API + outil **`web_search`** (remplace `search_parameters`, 410 si ancien format) — `bun run verify:xai` |
| **Telegram** (`TELEGRAM_API_*` + session) | Live channel scan — **optionnel** ; sinon **dex_proxy** |

## Sorties & rotation

Référence : **`APEX_QUANT_STRATEGY.md` §0** — profil **Rotation** (`TIME_STOP_SECONDS` / `HARD_MAX_HOLD_SECONDS` **300**), `ExitEngine` au démarrage log les seuils effectifs.

## Flux « trades » sans coût RPC tx (guérilla)

Entre deux lectures d’état bonding curve, **`TieredMonitor`** émet `syntheticTrade` si `|Δ realSol| ≥ 1000` lamports : `CurveTradeEvent` avec `synthetic: true`, trader `_reserve_flow`. Ça alimente **vélocité** et le **comptage d’achats** du `GraduationPredictor` ; les heuristiques **bot / concentration wallets** restent sur des **vraies** signatures si tu les ajoutes plus tard (ex. `getSignaturesForAddress` sur HOT — coût RPC).

## Ce qui est écrit en base

- `curve_snapshots` : un snapshot par poll **HOT** (features + `social_score`).
- `curve_outcomes` : graduation + évictions (snap **avant** delete dans `TieredMonitor`).
- `open_curve_positions` : positions paper persistées (`CURVE_POSITION_PERSIST`).
- `whale_wallets` : stats enrichies sur outcomes.

## Live Pump.fun (hors paper)

- `TRADING_MODE=live` **et** `TRADING_ENABLED=true` : sinon les envois on-chain CurveExecutor sont **refusés** (sécurité, aligné Sniper).
- `WALLET_PRIVATE_KEY` : clé **64 octets** (secret), pas la pubkey.

## Vérifications rapides

```bash
bun run verify          # Bun + typecheck
bun run verify:xai      # 1 appel Grok live (nécessite XAI_API_KEY)
bun run export:ml       # CSV sous data/
```

**Séquence de boot (curve-prediction)** : `CurveTracker` + DexScreener boosts + restore positions **avant** le WebSocket Pump.fun — sinon les premières courbes pouvaient ne jamais s’enregistrer. Si `CurveTracker` échoue, `PumpScanner` n’est pas lancé (évite des logs « enregistré » sans suivi).

## Export CSV (dataset)

```bash
bun run export:ml
```

### Fichiers produits

| Fichier | Usage ML / analytics |
|---------|----------------------|
| **`curve_training_labeled.csv`** | **Principal supervisé** : une ligne = un snapshot HOT au moment `t`, + labels outcome sur la courbe (`label_graduated` 0/1, `label_eviction_reason`, fins de trajectoire). Jointure `mint` = même token. Plusieurs lignes par `mint` → série temporelle ou dernier snapshot avant résolution. |
| `curve_snapshots.csv` | Tous les snapshots (brut), jusqu’à 50k lignes récentes. |
| `curve_outcomes.csv` | Une ligne par courbe résolue (graduation ou éviction). |
| `whale_wallets.csv` | Registre smart-money enrichi (si lignes). |
| `open_curve_positions.csv` | Positions ouvertes persistées (si présent). |
| `paper_trades.csv` | Historique paper depuis `paper_trades.jsonl`. |

### Colonnes features (snapshots) — alignées APEX / roadmaps V3–V4

Champs SQLite exportés tels quels (snake_case) : état courbe (`progress`, `real_sol_sol`, `price_sol`, `market_cap_sol`, `tier`, `trade_count`), prédicteur (`p_grad`, `confidence`, `breakeven`, `action`, `veto_reason`), microstructure (`sol_per_minute_*`, `avg_trade_size_sol`, `velocity_ratio`, `bot_transaction_ratio`, `smart_money_buyer_cnt`, `creator_is_selling`, `fresh_wallet_ratio`), **social** (`social_score` [0,1]), métadonnées (`prediction_ms`, `timestamp_ms`, `id`).

### Colonnes labels (préfixe `label_`)

- `label_graduated` : **1** = migration PumpSwap réussie, **0** = sinon (souvent éviction tier).
- `label_eviction_reason` : cause texte (ex. `hot_stalled_30min`, `graduated` implicite si `graduated=1` côté outcome).
- `label_final_progress`, `label_final_sol`, `label_duration_s`, `label_resolved_at`, `label_outcome_snapshot_count`.

**Note méthodo** : `label_graduated` est **rare** (~ordre 1 % des tokens) — prévoir class weights, métriques PR-AUC / F1, ou régression sur `label_final_progress` / durée.

## Préparer l’entraînement

1. Laisser tourner **24–48 h** en `TRADING_MODE=paper`, `STRATEGY_MODE=curve-prediction`.
2. Tableau de bord : section **Couche sociale** → `GrokX appels > 0` si les courbes passent par `fetchAndCacheCurveSocialScore` avec clé xAI ; **NarrativeRadar** thèmes actifs après 1–2 cycles.
3. Vérifier **Outcomes** et **snapshots** qui augmentent.
4. `bun run export:ml` → charger **`curve_training_labeled.csv`** pour l’entraînement supervisé ; les autres CSV pour analyses jointes / whales / paper.

## Limites réalistes (mars 2026)

- **Pas de parse tx par défaut** : la microstructure wallet-level (même acheteur, même block) est **partielle** tant que seuls les flux `_reserve_flow` sont présents ; la vélocité SOL est **réelle** (agrégat on-chain).
- **Graduation** = événement rare : les **outcomes** `graduated=true` mettent du temps à s’accumuler ; les **evicted** cold arrivent plus vite.
- **Telegram** sans `TELEGRAM_SESSION_STRING` : couche TG live off, **Dex proxy** + Groq/xAI/DexScreener restent actifs.
- **xAI** : modèle et quotas selon ton plan ; erreurs HTTP loguées (`⚠️ [GrokX]`, `⚠️ [NarrativeRadar]`).
