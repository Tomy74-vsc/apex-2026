# APEX-2026 — Audit détaillé (mars 2026)

**Date :** 19 mars 2026  
**Run de collecte :** 1h 52min  
**Mode :** curve-prediction (STRATEGY_MODE)

---

## 1. Résumé exécutif

Le bot est en **phase de collecte de données** pour entraîner le modèle ML du GraduationPredictor. La stratégie Bonding Curve (roadmapv2) est opérationnelle : détection, scoring heuristique, paper trades, et logging des snapshots. Le win rate n'est pas encore calculable car les outcomes (graduated/evicted) ne sont pas encore labellés en volume.

---

## 2. Résultats du run 1h52

| Métrique | Valeur |
|----------|--------|
| Uptime | 1h 51m 55s |
| Tokens détectés | 84 |
| Tokens snipés (paper) | 5 |
| PumpScanner signatures | 710 |
| Curves enregistrées | 84 |
| Filtrés (low SOL) | 364 |
| Late stage (>80%) | 25 |
| Check failed | 94 |
| WS Reconnects | 334 |
| Evaluated | 1225 |
| Entered | 6 |
| Skipped (cooldown) | 2293 |
| Curve snapshots logged | 22 172 |
| Outcomes (graduated/evicted) | 0 |

**Points notables :**
- Cooldown efficace : 2293 skips vs 6 enters.
- 22 172 snapshots en ~2h (~3/s).
- 334 reconnexions WS → instabilité du WS public Solana.
- 0 outcomes → aucune courbe n'a atteint graduation ou eviction pendant le run.

---

## 3. Architecture et implémentation

### 3.1 Flux curve-prediction (STRATEGY_MODE=curve-prediction)

```
PumpScanner (logsSubscribe) → onCurveCreate
       ↓
CurveTracker.register(mint) → TieredMonitor (Cold/Warm/Hot)
       ↓
BatchPoller.pollBatch() → stateUpdate → **Δ réserves → `syntheticTrade` → `CurveTracker.recordTrade`** (vélocité ; bot/wallet ignorent `synthetic`)
       ↓
TieredMonitor promote HOT → enterHotZone → fetch social (xAI+TG+Dex) → processCurveEvent → buy si ENTER
       ↓
CurveTracker.emit('curveUpdate', TrackedCurve) — chaque poll
       ↓
tier HOT → ensureSocialForHot (TTL) → appendHotObservationSnapshot (ML)
       ↓
DecisionCore.processCurveEvent() (si pas de position) → **CurveShadowAgent.evaluateCurve** (log/désaccord) → executeCurveBuyIfEnter
       ↓
app.ts → CurveExecutor.buy() (paper si TRADING_MODE=paper)
       ↓
graduated/evicted → labelCurveOutcome()
```

**Export ML** : `bun run export:ml` produit notamment **`curve_training_labeled.csv`** (snapshots JOIN `curve_outcomes`, colonnes `label_*`).

**Démarrage** : en `curve-prediction`, **`CurveTracker.start()`** (TieredMonitor prêt) s’exécute **avant** `PumpScanner.start()`, sinon `registerNewCurve` pouvait no-op (`tieredMonitor` null) si un log WS était traité très tôt.

### 3.2 Composants clés

| Composant | Rôle | Fichier |
|-----------|------|---------|
| PumpScanner | Détection via WS `logsSubscribe` (program Pump.fun). Filtre low SOL, late stage (>80%). Utilise `ws` npm (Bun WS incompatible). | `src/ingestors/PumpScanner.ts` |
| CurveTracker | Orchestre TieredMonitor + BatchPoller. Émet `curveUpdate`, `graduated`, `evicted`. | `src/modules/curve-tracker/CurveTracker.ts` |
| TieredMonitor | Cold/Warm/Hot selon progress. MAX_WARM=200, MAX_HOT=30. | `src/modules/curve-tracker/TieredMonitor.ts` |
| BatchPoller | `getMultipleAccounts` par batch 100. Backoff 429, MIN_POLL_GAP_MS=500. | `src/modules/curve-tracker/BatchPoller.ts` |
| GraduationPredictor | pGrad : VelocityAnalyzer si trades > 0, sinon heuristique (progress, SOL, age). | `src/modules/graduation-predictor/GraduationPredictor.ts` |
| BreakevenCurve | Calcule P(graduation) min pour rentabilité. | `src/modules/graduation-predictor/BreakevenCurve.ts` |
| AIBrain.decideCurve | ENTER_CURVE / SKIP selon pGrad vs breakeven. | `src/engine/AIBrain.ts` |
| DecisionCore | Cooldown 30s par mint, déduplication logs. MarketScanner désactivé en curve-prediction. | `src/engine/DecisionCore.ts` |
| CurveExecutor | Buy/Sell direct Pump.fun. WALLET_PRIVATE_KEY 64-byte Base58. | `src/modules/curve-executor/CurveExecutor.ts` |
| FeatureStore | curve_snapshots (~25 cols dont `social_score`), curve_outcomes, `queryLabeledCurveData` pour training. | `src/data/FeatureStore.ts` |

### 3.3 Heuristique pGrad (sans trades)

Quand `buyCount === 0`, `GraduationPredictor.predictFromCurveState()` :

- **progress** (55%) : sigmoïde centrée ~0.5
- **realSolSOL** (30%) : cap 50 SOL
- **ageDecay** (15%) : décroissance exponentielle

---

## 4. Composants traités (résumé des modifications)

| Problème | Solution |
|----------|----------|
| pGrad toujours 0% (trades vides) | Heuristique `predictFromCurveState()` |
| MarketScanner consomme RPC inutilement | Désactivé si `STRATEGY_MODE=curve-prediction` |
| PumpScanner `getMint()` RPC par curve | Supprimé, metadata hardcodée |
| 429 Too Many Requests | HOT_POLL 5s, backoff BatchPoller, MAX_HOT=30 |
| Logs ENTER_CURVE dupliqués | Cooldown 30s + Set dedup |
| CurveExecutor "bad secret key size" | bs58.decode pour Base58, 64-byte key |
| readyCurveBuy non géré | Handler app.ts → curveExecutor.buy() |
| Pas d'outcomes pour ML | curve_outcomes + labelCurveOutcome |
| Dashboard Outcomes null | COALESCE(SUM, 0) |
| WS "Expected 101" (Bun) | Package `ws` + perMessageDeflate: false |

---

## 5. Alignement roadmap.md

### Phase 1 — Infrastructure (partiel)

| Ticket | État | Note |
|--------|------|------|
| P1.1.1–1.1.4 FFI / Buffer Pool | ✅ | RustBridge, buffer-pool, fallback |
| P1.2.1 Yellowstone gRPC | ❌ | Non implémenté (free tier) |
| P1.2.2 StreamRouter | ❌ | Non implémenté |
| P1.3.1 ONNX Rust | ⚠️ | Scaffold présent, pas d'inférence |
| P1.4.1 Feature Store | ✅ | SQLite, curve_snapshots, curve_outcomes |

### Phases 2–5

- **Phase 2** (Ingestion) : WebSocket natif utilisé, pas gRPC.
- **Phase 3** (Modèles) : HMM/Hawkes en TS (fallback). TFT non intégré.
- **Phase 4** (Exécution) : Jito Bundles dans Sniper legacy. CurveExecutor direct Pump.fun.
- **Phase 5** (RL/ML) : Pipeline Python prêt. Données curve en collecte.

---

## 6. Alignement roadmapv2.md (Stratégie Bonding Curve)

### Sprint 1 — Fondation ✅

| Module | État |
|--------|------|
| pumpfun.ts | ✅ |
| bonding-curve.ts | ✅ |
| curve-math.ts | ✅ |
| test-curve-decode.ts | ✅ |
| BatchPoller | ✅ |
| TieredMonitor | ✅ |
| CurveTracker | ✅ |
| PumpScanner (modif) | ✅ |

### Sprint 2 — Signaux ✅ (partiel)

| Module | État |
|--------|------|
| VelocityAnalyzer | ✅ |
| BotDetector | ✅ |
| WalletScorer | ✅ |
| HolderDistribution | ❌ |
| BreakevenCurve | ✅ |
| FeatureAssembler (30+ features) | ⚠️ | 12-dim legacy, pas 30+ curve |
| FeatureStore (curve schema) | ✅ |

### Sprint 3 — Prédiction + Exécution ✅

| Module | État |
|--------|------|
| GraduationPredictor | ✅ |
| CurveExecutor | ✅ |
| JitoBundler (curve) | ⚠️ | Non dédié curve |
| AIBrain.decideCurve | ✅ |
| DecisionCore (curve-prediction) | ✅ |
| Guard (curve-specific) | ⚠️ | Partiel |

### Sprint 4 — Risk (non prioritaire)

| Module | État |
|--------|------|
| StallDetector | ❌ |
| PortfolioGuard | ❌ |
| GraduationExitStrategy | ❌ |
| KellyEngine (P(graduation)) | ⚠️ | Non adapté curve |

---

## 7. Prochaines étapes

### Court terme (collecte 48h+)

1. **Lancer le bot** : `STRATEGY_MODE=curve-prediction bun run src/app.ts`
2. **Surveiller** : Outcomes (🎓/💀) — actuellement 0 car cycle graduation/eviction > 2h
3. **WS** : 334 reconnects → envisager Helius WS payant ou Triton si quota OK

### Moyen terme (ML)

1. **Exporter** : `FeatureStore.queryLabeledCurveData()` quand outcomes > 0
2. **Entraîner** : Python pipeline sur `curve_snapshots` + `curve_outcomes`
3. **Remplacer** : Heuristique pGrad par modèle ONNX

### Long terme (roadmap)

1. **HolderDistribution** : Enrichir features
2. **StallDetector / PortfolioGuard** : Risk management curve
3. **GraduationExitStrategy** : Sortie optimale à graduation
4. **KellyEngine** : Sizing basé sur P(graduation)

---

## 8. Conclusion

Le bot est **opérationnel en mode curve-prediction** : détection, scoring heuristique, paper trades, et logging des snapshots. La collecte de données est en cours. Le win rate sera calculable une fois suffisamment d'outcomes (graduated/evicted) labellés. L'alignement avec roadmapv2 est fort sur les Sprints 1–3 ; les modules risk (Sprint 4) et l'extension des features restent à faire.
