# Registre — `directive_final.md` (analyse + suivi d’exécution)

**Source canonique :** [`directive_final.md`](./directive_final.md) (1288 lignes, 24 mars 2026).  
**Usage :** copier chaque bloc `PROMPT CURSOR N` dans Composer, dans l’ordre 1→9 ; `bun run typecheck` après chaque prompt.

---

## 1. Synthèse stratégique (ce que la directive impose)

| Axe | Intention |
|-----|-----------|
| **Diagnostic** | WR faible car entrées courbe « légères » vs ancien sniper « full Guard » |
| **Décision** | Abandon du mode sniper / Raydium ; **un seul** mode supporté : `curve-prediction` |
| **Pièce centrale** | `CurveTokenAnalyzer` — analyse async, cache 5 min, couches security / holders / liquidity / social / verdict |
| **Intégration** | Pré-analyse au passage HOT + lecture cache dans `processCurveEvent` ; enrichissement `GraduationPredictor` |
| **Bugs audit** | Stall (`hasMicro`), hard time vs `livePGrad`, régression progress, évictions tier lentes, double-label, confidence 0-trade |
| **Sélectivité** | Durcir prédicteur (objectif taux d’entrée HOT ~5–15 %) |
| **Risk** | `PortfolioGuard` centralisé |
| **Ops** | Dashboard 5 min, AGENTS.md à jour, `.env.example` + `validateEnv()` |

---

## 2. Carte des 9 prompts (livrabes et fichiers clés)

| # | Titre | Livrables principaux | Fichiers ciblés (directive) |
|---|--------|----------------------|----------------------------|
| **1** | Suppression sniper | `STRATEGY_MODE` forcé `curve-prediction` ; plus de `processMarketEvent` / scanner actif ; `MarketScanner.ts` conservé mais marqué DEPRECATED | `app.ts`, `DecisionCore.ts`, `MarketScanner.ts` (bannière), `Guard.ts` (commentaire `analyzeToken`), `types/index.ts`, `.env.example` |
| **2** | `CurveTokenAnalyzer` | Nouveau module + interface `FullCurveAnalysis` ; cache + inflight ; layers en `Promise.allSettled` ; timeout 8 s | `src/detectors/CurveTokenAnalyzer.ts`, `src/types/index.ts` |
| **3** | Intégration DecisionCore | Pré-analyse HOT en fond ; `getCached` dans `processCurveEvent` ; lien `GraduationPredictor` + confidence dynamique ; **confidence heuristique 0.20** ; logs `[EVAL]` | `DecisionCore.ts`, `GraduationPredictor.ts` |
| **4** | Fix bugs Exit / Tier / FeatureStore | Stall sans `hasMicro` ; hard time stop non contournable ; régression progress ; évictions agressives COLD/WARM/HOT ; idempotence `labelCurveOutcome` | `ExitEngine.ts`, `TieredMonitor.ts`, `FeatureStore.ts` |
| **5** | Durcir `GraduationPredictor` | Vétos étage 1 + breakeven × marge + Kelly ; stats vétos ; logging | `GraduationPredictor.ts`, env |
| **6** | `PortfolioGuard` | Singleton `canEnter`, caps, halt journalier, `calcPositionSize` | `src/modules/risk/PortfolioGuard.ts`, `DecisionCore.ts`, `app.ts` (reset minuit) |
| **7** | Dashboard terminal | `setInterval` 5 min + log unifié `[EVAL]` | `app.ts`, intégrations stats TieredMonitor / Predictor / PM |
| **8** | AGENTS.md | Corrections « trailing / Grok / WebSocketPool / confidence / sniper removed » + section modules récents | `AGENTS.md` |
| **9** | Env + validation boot | `validateEnv()` ; `.env.example` exhaustif | `app.ts`, `.env.example` |

---

## 3. Dépendances entre prompts

```text
1 (architecture) → 2 (analyzer) → 3 (câblage DC + predictor)
                              ↘
4 (bugs) peut chevaucher 3 ; 5 renforce predictor (après 2–3 idéalement)
6 après 1–3 (besoin DecisionCore stable)
7 après 6 + stats disponibles
8–9 en fin de chaîne (doc + contrat env)
```

---

## 4. Références manquantes ou ambiguës dans la directive

| Point | Détail |
|-------|--------|
| **Prompt 4** cite `@file CURSOR_DIRECTIVE_ROTATION_AGRESSIVE.md` | **Fichier absent** du dépôt (mars 2026) — utiliser `APEX_QUANT_STRATEGY.md` §0/§8 + `ExitEngine.ts` comme référence à la place. |
| **Prompt 9 — `TIME_STOP_SECONDS=600`** | Résolu dans `.env.example` : **300 s** par défaut (Rotation) + commentaire **Conservation = 600** explicite. |
| **Prompt 9 — wallet au boot** | Résolu : `validateEnv()` n’exige **pas** `WALLET_PRIVATE_KEY` en `TRADING_MODE=paper` ; exigence seulement si `live` + `TRADING_ENABLED=true`. |
| **`tieredMonitor:promoted`** (Prompt 3) | Non utilisé : pré-chauffe via `enterHotZone` + `getCurveTokenAnalyzer().analyze` (spec plan unifié). |
| **`getTieredMonitor().getStats()`** (Prompt 7) | Délégation existante : `getCurveTracker().getStats()` → `TieredMonitor.getStats()`. |

---

## 5. État du dépôt **avant** exécution de la directive (repère technique)

Mesures utiles pour cocher la progression (à mettre à jour après chaque prompt) :

| Élément | État typique pré-directive |
|---------|----------------------------|
| `MarketScanner` / `processMarketEvent` | Encore présents dans `DecisionCore` si `STRATEGY_MODE !== curve-prediction` |
| `CurveTokenAnalyzer` | **Absent** |
| `PortfolioGuard` dédié | **Absent** (caps épars : env + `Guard.validateCurve` + `AIBrain`) |
| Double-label graduation | Souvent géré côté **`app.ts`** (`evicted` + `reason === 'graduated'`) — la directive demande aussi garde-fou dans `FeatureStore.labelCurveOutcome` |
| `ExitEngine` hard max + stall | Déjà partiellement aligné APEX — **vérifier** condition `hasMicro` et ordre bypass `livePGrad` vs directive |
| `predictFromCurveState` confidence | Code souvent **0.15** ; directive impose **0.20** + alignement AGENTS |
| `GraduationPredictor` | Vétos et poids APEX **déjà** en grande partie — Prompt 5 = convergence / durcissement, pas réécriture from scratch |

---

## 6. Critères de validation finale (extraits directive)

Après exécution complète + ~4 h paper :

- 0 crash / heure
- Positions ouvertes et fermées visibles (dashboard)
- Taux d’entrée HOT **< 15 %** (objectif sélectivité)
- Veto stats loguées (ex. toutes les 30 min si implémenté)
- `curve_outcomes` non vide ; `bun run export:ml` utile
- WR paper > 30 % (ambitieux sans ML — à interpréter avec variance)
- Logs d’analyse complète sur les ENTER (une fois Prompt 2–3 livrés)

Objectif données : **2000+** outcomes puis LightGBM (hors scope code immédiat).

---

## 7. Journal d’exécution (à remplir manuellement)

| Prompt | Date | Typecheck OK | Notes |
|--------|------|--------------|-------|
| 1 | 2026-03-23 | ☑ | `DecisionCore` curve-only + throw ; `MarketScanner` DEPRECATED ; log architecture |
| 2 | 2026-03-23 | ☑ | `CurveTokenAnalyzer.ts` + `FullCurveAnalysis` |
| 3 | 2026-03-23 | ☑ | HOT pré-analyse, cache gate, `predict` + `decideCurve` fusion `fullAnalysis`, conf. heuristique 0.20 |
| 4 | 2026-03-23 | ☑ | `PROGRESS_DROP_VETO`, FeatureStore first-write ; TieredMonitor inchangé (déjà aligné) |
| 5 | 2026-03-23 | ☑ | `SAFETY_MARGIN_BASE`, fusion analyse — Kelly unique dans `AIBrain` |
| 6 | 2026-03-23 | ☑ | `PortfolioGuard` + `MAX_CONCURRENT_*` alias |
| 7 | 2026-03-23 | ☑ | `🔍 [EVAL]` 5 min + stats `CurveTracker` |
| 8 | 2026-03-23 | ☑ | `AGENTS.md` (courbe-only, modules 2026-03) |
| 9 | 2026-03-23 | ☑ | `validateEnv`, `.env.example` harmonisé |

---

## 8. Fichiers **nouveaux** attendus après implémentation totale

- `src/detectors/CurveTokenAnalyzer.ts`
- `src/modules/risk/PortfolioGuard.ts`
- (Optionnel) tests ou scripts de smoke mentionnés dans la directive

---

## 9. Vérification raodmap / runbook (Wave J, 2026-03-23)

- **Social / quant** : `GrokXScanner.ts`, `NarrativeRadar.ts`, `SentimentAggregator.ts`, `SocialTrendScanner.ts`, `TelegramTokenScanner.ts`, `WhaleWalletDB.ts` présents sous `src/` ; scripts `bun run discover:whales` / `seed:whales` dans `package.json` ; collecte ML documentée `COLLECTION_RUNBOOK.md` + `bun run export:ml`.
- **Alignement APEX** : poids §5 et `safety_margin(confidence)` inchangés en logique de base ; ajouts = plancher `SAFETY_MARGIN_BASE`, `PROGRESS_DROP_VETO`, `CurveTokenAnalyzer` / `PortfolioGuard` (pas de second Kelly dans le prédicteur).

*Ce registre ne remplace pas `directive_final.md` : il sert de table des matières, de checklist et de notes d’écart pour l’équipe et les agents.*
