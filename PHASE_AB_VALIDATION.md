# APEX-2026 — Validation Phase A + Phase B (paper trading)

Référence : `APEX_QUANT_STRATEGY.md`, `roadmapv3.md` (M1–M4 + P2/P3), `AGENTS.md` (sections Phase A / B).

## Pré-requis

- `STRATEGY_MODE=curve-prediction`, `TRADING_MODE=paper`
- RPC : `HELIUS_RPC_URL` ou `RPC_URL` (idéalement + `QUICKNODE_RPC_URL` pour le race)
- `bun run typecheck` → 0 erreur

## Variables d’environnement alignées plan (défauts = **APEX §0 + §12** + code)

| Domaine | Variables |
|--------|-----------|
| Zone d’entrée | `CURVE_ENTRY_MIN_PROGRESS` (0.45), `CURVE_ENTRY_MAX_PROGRESS` (0.85), `MIN_TRADING_INTENSITY`, `MIN_TRADE_COUNT`, `MIN_MINUTES_IN_HOT` |
| Vétos | `VETO_BOT_RATIO`, `VETO_MAX_AGE_MINUTES`, `VETO_MIN_FRESH_PROGRESS`, `VETO_VELOCITY_RATIO` |
| Breakeven | Marge dynamique `safety_margin(confidence)` dans `BreakevenCurve` (pas de `SAFETY_MARGIN` fixe seul) |
| EntryFilter (v4 1C) | `MIN_VELOCITY_SOL_MIN`, `ENTRY_VELOCITY_WINDOW_SEC`, `MAX_TRIVIAL_TX_RATIO`, `TRIVIAL_TX_SOL`, `ENTRY_FILTER_MIN_BUYS_TRIVIAL` |
| Kelly / taille | `KELLY_FRACTION`, `MAX_POSITION_PCT`, **`MAX_POSITION_SOL`**, `MIN_POSITION_SOL`, `MIN_KELLY_FRACTION`, `PAPER_BANKROLL_SOL` |
| Sorties | `STOP_LOSS_PCT`, `TRAILING_STOP_PCT`, `TAKE_PROFIT_PCT`, `TIME_STOP_SECONDS` (**300** profil Rotation), `HARD_MAX_HOLD_SECONDS` (**300**), `TIME_STOP_MIN_PGRAD`, `STALL_SOL_FLOW_MIN` (**0.05**), `STALL_DURATION_SECONDS` (**90**), `EXIT_EVAL_COOLDOWN_MS`, `STALL_VELOCITY_THRESHOLD` (réservé, non ExitEngine), `LIVE_PGRAD_REFRESH_MS` — détail **`APEX_QUANT_STRATEGY.md` §0 + §8** |
| Graduation exit | `GRAD_T1_PCT`, `GRAD_T2_PCT`, `GRAD_T2_DELAY_MS` (60_000), `GRAD_T3_DELAY_MS` |
| Persistance A | `CURVE_POSITION_PERSIST`, `PAPER_TRADE_LOG`, `PAPER_TRADE_LOG_PATH` |
| TieredMonitor | `TIER_HOT_STALL_MIN`, `TIER_HOT_MAX_AGE_MIN`, `TIER_WARM_MAX_AGE_MIN`, `TIER_COLD_STALE_MIN`, `TIER_PROGRESS_COLLAPSE_MIN`, `TIER_EVICTION_SWEEP_MS` |

## Checklist run paper 2–4 h

### 1. Démarrage

- [ ] Logs `PositionManager` / restore SQLite si positions ouvertes (`CURVE_POSITION_PERSIST≠0`)
- [ ] `🛡️ [ExitEngine]` avec durées (max hold, stall, time-stop pGrad)
- [ ] `🚀 [TieredMonitor] Started` + sweep eviction

### 2. Boucle trade (Phase A)

- [ ] Après un `ENTER` paper : log ouverture position (`💰 [PositionManager] OPENED` ou équivalent)
- [ ] Sur `curveUpdate` avec position : `updatePosition` + évaluation `ExitEngine`
- [ ] Fermetures : `stop_loss` / `stall` / `time_stop` / `take_profit` / `graduation` visibles (`🚨 [ExitEngine]`)
- [ ] `GraduationExitStrategy` : T1 puis timers T2/T3 (`🎓 [GradExit]`)
- [ ] `data/paper_trades.jsonl` grossit si `PAPER_TRADE_LOG` actif
- [ ] Au SIGINT : flush FeatureStore / positions sans crash

### 3. Sélectivité & data (Phase B)

- [ ] **Entrées** : beaucoup de `⏭️` / vetos — **pas** 100 % des HOT qui entrent
- [ ] Logs `🚧 [DecisionCore:EntryFilter]` (vélocité / trivial tx)
- [ ] Compteurs veto prédicteur (dashboard ou stats) : `progress_band`, `below_breakeven_margin`, `min_trades`, etc.
- [ ] **Évictions** : `TieredMonitor` `evictions` > 0 sur la durée
- [ ] SQLite : `curve_outcomes` et/ou snapshots qui progressent (pas figés à 0)

### 4. Requêtes SQLite rapides (optionnel)

Base : `data/apex.db` (tableau `FeatureStore`).

```sql
SELECT COUNT(*) FROM curve_outcomes;
SELECT COUNT(*) FROM curve_snapshots
  WHERE timestamp_ms > ((strftime('%s','now') * 1000) - 4 * 3600 * 1000);
SELECT eviction_reason, COUNT(*) FROM curve_outcomes GROUP BY eviction_reason;
```

### 5. Critères de succès Phase B

| Critère | Cible |
|--------|--------|
| Typecheck | OK |
| Positions suivies | Oui (mint, PnL, fermetures) |
| Taux d’entrée HOT | ≪ 100 % |
| Outcomes / évictions | Croissance visible sur 2–4 h |
| Pas de boucle buy sans sell | Aucune position « oubliée » sans chemin exit |

## Hors scope Phase A/B (ne pas bloquer la validation)

- `WebSocketPool` (Phase C)
- `SocialTrendScanner`, `TelegramTokenScanner`, `WhaleWalletDB`, Grok
- Trailing 15 % sur la moitié restante après take-profit 50 % (dette documentée dans `AGENTS.md`)
- Éviction COLD « 15 min + pGrad &lt; 10 % » (roadmapv4) : non couplée au prédicteur dans `TieredMonitor` ; utiliser `TIER_COLD_STALE_MIN` pour rapprocher

## Commande suggérée

```bash
bun run start
```

Avec env dans `.env` ou préfixe shell : `STRATEGY_MODE=curve-prediction`, `TRADING_MODE=paper` (voir `package.json` script `start`).
