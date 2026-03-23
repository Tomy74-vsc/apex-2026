# APEX-2026 — STRATÉGIE QUANTITATIVE DÉFINITIVE

**Classification :** Propriétaire — Lead Quant Architect  
**Date :** 20 mars 2026  
**Fondement :** Marino et al. (arXiv:2602.14860) + Théorie des marchés microstructurels  
**Objectif :** Maximiser le Sharpe ratio sur le marché Pump.fun bonding curves

---

## SECTION 0 : RÉFÉRENCE UNIQUE — PROFIL SORTIE + SOCIAL

### 0.1 Source de vérité

Ce document est la **seule** référence chiffrée pour la stratégie quant (entrées, poids, sorties, env). `raodmap_final.md`, `roadmapv3.md`, `roadmapv4.md` et `PHASE_AB_VALIDATION.md` renvoient ici pour les nombres ; toute modification de paramètres prod passe par une mise à jour de **cette** section et de **§12**.

### 0.2 Profil de sortie canonique : **Rotation agressive** (slots)

**Décision (mars 2026) :** un seul profil par défaut — **Rotation** (directive `raodmap_final.md`, PROMPT 0) : libérer vite les **5 slots** face aux courbes stagnantes. Le profil historique **Conservation** (time stop ~10 min, stall plus lent) n’est **pas** le défaut repo ; il reste disponible uniquement en relevant volontairement les variables d’§12.

| Paramètre | Rotation (défaut) | Conservation (optionnel) |
|-----------|-------------------|---------------------------|
| `TIME_STOP_SECONDS` | **300** | 600 |
| `HARD_MAX_HOLD_SECONDS` | **300** (aucun bypass pGrad) | ≥ 600 |
| `STALL_DURATION_SECONDS` | **90** | 120 |
| `STALL_SOL_FLOW_MIN` | **0.05** | 0.1 |
| `EXIT_EVAL_COOLDOWN_MS` | **3000** | 3000–5000 |

**Interaction hard / soft :** si `HARD_MAX_HOLD_SECONDS` ≤ `TIME_STOP_SECONDS`, la sortie à l’échéance est toujours **hard** (pas de prolongation via `livePGrad`). Pour autoriser le bypass pGrad après le soft stop tout en gardant un plafond absolu plus tard, fixer `TIME_STOP_SECONDS` < `HARD_MAX_HOLD_SECONDS` (ex. 300 / 420).

### 0.3 Poids de scoring : **fixes APEX** ; signal social **dynamique**

**Décision :** les coefficients **wᵢ** de la §5 (dont **0.07** pour le social) restent **constants** dans `GraduationPredictor` — c’est le comportement **prod** actuel et aligné Marino.

- **Dynamique** : uniquement la **valeur** du signal social dans `[0,1]` (ex. `SentimentAggregator.computeComposite` mélangeant Grok / Telegram / Dex quand câblés), pas les poids eux-mêmes.
- **Non retenu sans spec + code** : redistribution dynamique des wᵢ (ex. augmenter le poids social quand la narrative explose). Si implémenté plus tard : feature flag explicite, tests, et mise à jour de **cette** section + §5.

---

## SECTION 1 : POURQUOI 99% DES BOTS PERDENT DE L'ARGENT

Le taux de graduation Pump.fun est de **~1.15% en mars 2026** (source : Dune Analytics/Cryptopolitan). Cela signifie que sur 100 tokens, environ 1 seul atteindra les ~85 SOL dans sa bonding curve et migrera vers PumpSwap.

**Le problème mathématique fondamental :**

Si tu achètes à l'aveugle à T=0 (stratégie snipe classique) :
- Probabilité de graduation : P = 0.0115
- Gain si graduation (entry T=0 → grad) : ~17× (prix à 0 SOL → prix à 85 SOL)
- Perte si échec : -100% (le token meurt)
- Fee aller-retour : 2.5% (1.25% × 2)

**Espérance mathématique du snipe aveugle :**
```
E[R] = P × (17 - 0.025) + (1-P) × (-1)
     = 0.0115 × 16.975 + 0.9885 × (-1)
     = 0.195 - 0.989
     = -0.794
```

**L'espérance est de -79%.** Le sniping aveugle est un suicide mathématique.

---

## SECTION 2 : L'INSIGHT FONDAMENTAL DE MARINO ET AL.

Le papier arXiv:2602.14860 prouve que la probabilité de graduation **n'est pas constante** — elle est conditionnelle à l'état actuel de la bonding curve et à 4 variables comportementales.

### La probabilité conditionnelle P(grad | vSol, X)

La probabilité de graduation sachant que le token a déjà accumulé `vSol` SOL dans sa courbe et un vecteur de variables X est :

```
P(graduation | vSol) est une fonction monotone croissante de vSol
```

Plus il y a de SOL dans la courbe, plus la probabilité de graduation augmente — c'est évident mais quantifiable. Le papier montre que :

| vSol (SOL réel) | P(grad) base | P(grad) avec fort trading intensity |
|-----------------|-------------|--------------------------------------|
| 5 SOL (~8%)     | ~2-3%       | ~5-8%                                |
| 15 SOL (~25%)   | ~8-12%      | ~15-25%                              |
| 30 SOL (~50%)   | ~15-25%     | ~30-50%                              |
| 45 SOL (~65%)   | ~30-45%     | ~50-70%                              |
| 60 SOL (~80%)   | ~50-65%     | ~70-85%                              |
| 75 SOL (~92%)   | ~75-85%     | ~90-98%                              |

### Les 4 variables de conditionnement (par puissance prédictive)

**1. INTENSITÉ TRANSACTIONNELLE (DOMINANT)**  
Nombre de trades nécessaires pour atteindre le niveau vSol actuel.
- MOINS de trades = chaque trade est GROS = engagement réel = PLUS de chance de graduer
- C'est la variable #1 du papier — elle domine TOUTES les autres
- Un token qui atteint 30 SOL en 50 trades est 3× plus susceptible de graduer qu'un token qui atteint 30 SOL en 500 trades

**Formule de l'intensité :**
```
TI(vSol) = vSol / N_trades(vSol)   (SOL moyen par trade)
```

Seuil optimal identifié : `TI > 0.3 SOL/trade` → signal fortement positif.

**2. ACTIVITÉ BOT (NÉGATIF)**
- Ratio de transactions avec des patterns bot (petits montants uniformes, wallets frais, même slot)
- Au-delà de ~50% de vSol, un ratio bot élevé DIMINUE significativement P(grad)
- Les bots génèrent du volume mais pas d'engagement réel en capital

**3. SMART MONEY / TRADERS HISTORIQUEMENT RENTABLES (MODESTE)**
- Effet "modeste et non-monotone" selon le papier
- Positif en early stage (validation)
- Potentiellement négatif en late stage (ils sortent avant graduation)

**4. CRÉATEUR (LIMITÉ, MAIS VÉTO)**
- Les "top creators" (beaucoup de tokens) sont corrélés avec des pump & dump
- Un créateur qui a déjà 10+ tokens = signal négatif
- Un créateur qui vend pendant la bonding curve = RED FLAG absolu

---

## SECTION 3 : LA COURBE DE BREAKEVEN ÉCONOMIQUE

C'est la pièce mathématique la plus importante de notre stratégie. Le breakeven définit le MINIMUM de P(graduation) nécessaire pour que l'entrée soit rentable.

### Dérivation formelle

Le prix sur la bonding curve est :
```
P(vSol) = (30 + realSol) / vToken(realSol)
```

Où vToken est déterminé par l'invariant constant-product :
```
k = x₀ × y₀ = 30 × 1.073×10⁹ = 3.219×10¹⁰
vToken = k / (30 + realSol)
P(realSol) = (30 + realSol)² / k
```

Le prix à graduation (realSol = 85) :
```
P_grad = (30 + 85)² / k = 115² / 3.219×10¹⁰ = 4.109×10⁻⁷ SOL/token
```

Le prix à un point d'entrée realSol :
```
P_entry(realSol) = (30 + realSol)² / k
```

Le multiple de prix entry→graduation :
```
M(realSol) = P_grad / P_entry = (115 / (30 + realSol))²
```

| realSol (SOL) | Progress | Prix relatif | Multiple à graduation | Breakeven P(grad) |
|---------------|----------|-------------|----------------------|-------------------|
| 5             | 8%       | 1.00×       | 10.8×                | 9.5%              |
| 15            | 25%      | 1.56×       | 6.94×                | 14.7%             |
| 25            | 40%      | 2.27×       | 4.75×                | 21.5%             |
| 35            | 55%      | 3.13×       | 3.45×                | 29.6%             |
| 45            | 65%      | 4.12×       | 2.62×                | 38.9%             |
| 55            | 75%      | 5.27×       | 2.05×                | 49.8%             |
| 65            | 85%      | 6.57×       | 1.65×                | 62.0%             |
| 75            | 92%      | 8.02×       | 1.35×                | 75.7%             |

### La formule du breakeven avec fees

```
P_breakeven(realSol) = (1 + f) / (M(realSol) × (1 - f))
                     = 1.0125 / (M(realSol) × 0.9875)

Où f = 1.25% (fee Pump.fun par trade)
```

---

## SECTION 4 : LA ZONE D'ENTRÉE OPTIMALE — "THE SWEET SPOT"

### Le théorème de l'edge maximum

L'edge de trading est défini comme :
```
Edge(realSol, X) = P(grad | realSol, X) - P_breakeven(realSol)
```

L'edge doit être STRICTEMENT POSITIF pour entrer. Plus l'edge est grand, plus la position doit être grosse (Kelly).

**Le sweet spot se trouve là où l'edge est maximisé :**

À 35-55 SOL (55-75% progress) :
- P(grad) base : 30-50%
- P(grad) avec forte intensité : 50-70%
- P_breakeven : 30-50%
- Edge AVEC forte intensité : 15-30%
- Multiple à graduation : 2-3.5×

**C'est la SEULE zone où :**
1. La probabilité conditionnelle dépasse significativement le breakeven
2. Le multiple à graduation offre encore un upside significatif (2-3.5×)
3. Les signaux de trading intensity sont les plus informatifs (Marino et al.)
4. Le temps restant avant graduation est court (5-20 min typiquement)

**Avant 35 SOL :** P(grad) trop faible pour couvrir le breakeven sauf signal exceptionnel.
**Après 65 SOL :** Le breakeven monte à 62%+, et le multiple tombe à 1.65× — le risk/reward se dégrade même si P(grad) est élevé.

---

## SECTION 5 : LE MODÈLE DE SCORING OPTIMAL

### Architecture : 2 étages + 3 vétos

```
ÉTAGE 1 : VÉTOS ABSOLUS (< 0.1ms, binaire)
  Si l'un de ces vétos fire → SKIP, pas d'exception :
  
  V1. creatorIsSelling = true        → SKIP (rug pull imminent)
  V2. botRatio > 0.70               → SKIP (manipulation pure)
  V3. tradingIntensity < 0.15 SOL   → SKIP (pas d'engagement)
  V4. progress < 0.45 ou > 0.85     → SKIP (hors sweet spot)
  V5. ageMinutes > 45 et progress < 0.60 → SKIP (momentum mort)

ÉTAGE 2 : SCORING PONDÉRÉ → P(graduation) estimée

  pGrad = Σ wᵢ × sᵢ(X)

  Avec les poids dérivés de la puissance prédictive de chaque variable :
```

### Les 7 signaux et leurs poids optimaux

| Signal | Poids | Calcul | Justification |
|--------|-------|--------|---------------|
| **Trading Intensity** | **0.35** | `min(1, avgSolPerTrade / 1.0)` | Variable #1 du papier — domine tout |
| **Velocity Momentum** | **0.20** | `min(1, solPerMin_1m / 3.0) × velocityRatio` | Accélération = conviction du marché |
| **Anti-Bot Score** | **0.15** | `1 - botTransactionRatio` | Bot activity ↑ → graduation ↓ |
| **Holder Quality** | **0.10** | `(1 - freshWalletRatio) × (1 - top10Concentration/100)` | Diversité = santé |
| **Smart Money** | **0.08** | `min(1, smartMoneyBuyerCount / 3)` | Signal modeste mais utile |
| **Social Signal** | **0.07** | `grokXScore × 0.5 + telegramScore × 0.3 + dexScreenerBoost × 0.2` | Attention externe |
| **Progress Sigmoid** | **0.05** | `1 / (1 + e^(-12 × (progress - 0.55)))` | Prior bayésien sur l'avancement |

*Impl. social :* `SentimentAggregator.computeComposite` produit un score **[0,1] dynamique** qui est multiplié par le poids **fixe** 0.07 (voir **§0.3** — pas de w_social variable en prod sans nouveau gate).

### Pourquoi ces poids spécifiques

Le papier de Marino montre quantitativement que le trading intensity est la seule variable qui **pousse systématiquement** la probabilité conditionnelle au-dessus de la courbe de breakeven, sur TOUTE la gamme de vSol. Les bots, le smart money, et le créateur sont des filtres/modulateurs — pas des prédicteurs primaires.

Le velocity momentum (accélération du flux SOL) est notre contribution propre : il capture la *dynamique temporelle* que le papier ne mesure pas directement car il conditionne sur des snapshots statiques. Un token qui accélère à 55% progress est radicalement différent d'un token qui décélère à 55%.

---

## SECTION 6 : CONDITION D'ENTRÉE — LE FILTRE BAYÉSIEN

### Règle d'entrée formelle

```
ENTER si et seulement si :
  1. Tous les vétos V1-V5 sont CLEAR
  2. pGrad > P_breakeven(realSol) × safety_margin
  3. Kelly fraction f* > 0.01 (l'edge est assez large pour risquer du capital)
```

### Le safety margin optimal

Le safety margin n'est PAS un nombre fixe — il dépend de la confiance dans l'estimation de pGrad.

```
safety_margin(confidence) = 1 + (1 - confidence) × 0.8
```

| Confiance | Safety margin | Signification |
|-----------|--------------|---------------|
| 0.20 (heuristique) | 1.64× | On exige pGrad 64% au-dessus du breakeven |
| 0.50 (quelques trades) | 1.40× | Marge de 40% |
| 0.80 (bon signal) | 1.16× | Marge de 16% |
| 0.95 (ML model trained) | 1.04× | Quasiment au breakeven |

**Heuristique sans trades (confidence 0.15 dans le code) :** safety_margin ≈ 1.68×

Ce qui veut dire qu'à 45 SOL (breakeven = 39%), on exige pGrad > 59% pour entrer. C'est TRÈS sélectif — et c'est voulu. On préfère manquer 10 opportunités que de perdre sur 1.

### Pourquoi le win rate augmente avec la sélectivité

La distribution des tokens n'est pas uniforme. En sélectionnant uniquement les tokens avec pGrad > breakeven × 1.5 :
- On élimine ~85% des tokens HOT (ceux qui vont échouer)
- On garde les ~15% avec le profil le plus fort
- Le win rate attendu passe de ~15% (entering tout) à ~45-60%
- Combiné avec un multiple moyen de 2-3× sur les gagnants, l'espérance est :

```
E[R | sélectif] = 0.50 × 2.5 + 0.50 × (-0.50)   [moyenne des exits, pas -100%]
                = 1.25 - 0.25
                = +1.00 (+100% espérance par trade sélectionné)
```

La clé est que les pertes ne sont PAS de -100% grâce au stop-loss à -15% et au stall detector.

---

## SECTION 7 : POSITION SIZING — KELLY CRITERION ADAPTATIF

### Formule de Kelly pour bonding curves

```
f* = (b × p - q) / b

Où :
  p = P(graduation | X) — notre estimation
  q = 1 - p
  b = M(realSol) - 1 — le multiple net à graduation
```

### Fractional Kelly avec régime adjustment

On utilise **quarter-Kelly** (f*/4) pour deux raisons :
1. Nos estimations de p ont une variance élevée (early stage ML)
2. Le drawdown avec full Kelly est trop violent pour un bankroll de 1-5 SOL

```
position_SOL = min(
  (f* / 4) × bankroll,
  MAX_POSITION_SOL,
  bankroll × MAX_POSITION_PCT
)
```

*Impl. `AIBrain.decideCurve` :* `M = calcExpectedReturnOnGraduation(realSol)` (multiple prix entry→grad), `b = M - 1`, `f* = (b×p − q)/b`, puis `position_SOL = min(f* × KELLY_FRACTION × bankroll, MAX_POSITION_SOL, bankroll × MAX_POSITION_PCT)` avec `KELLY_FRACTION` défaut 0.25 (quarter-Kelly).

### Exemple numérique

```
Token à 45 SOL (65% progress) :
  p = 0.55 (notre estimation)
  b = 2.62 - 1 = 1.62 (multiple net)
  q = 0.45
  
  f* = (1.62 × 0.55 - 0.45) / 1.62
     = (0.891 - 0.45) / 1.62
     = 0.272 (27.2% du bankroll en full Kelly)
  
  f*/4 = 0.068 (6.8% du bankroll)
  
  Avec bankroll = 2 SOL :
  position = min(0.068 × 2, 0.5, 2 × 0.10)
           = min(0.136, 0.5, 0.2)
           = 0.136 SOL
```

---

## SECTION 8 : STRATÉGIE DE SORTIE — CASCADE (IMPL EXITENGINE)

### Hiérarchie de sortie (ordre réel dans le code)

Ordre d’évaluation `ExitEngine.evaluate()` :

```
1. GRADUATION        → 3 tranches (40% / 35% / 25%) si courbe complète / progress ≥ 0.99
2. STOP-LOSS         → Sell 100% si PnL < -15%
3. PROGRESS REGRESSION → Sell 100% si progress actuel < progress à l’entrée − 10 points
4. HARD TIME STOP    → Sell 100% si hold > HARD_MAX_HOLD_SECONDS (aucun bypass pGrad)
5. (cooldown eval)   → puis trailing, collapse, stall, soft time, take profit
6. TRAILING STOP     → Sell 100% si drawdown depuis peak > 20% (après profit > 10%)
7. VELOCITY COLLAPSE → Sell 100% si ratio/accel collapse + flux faible (seuil stall)
8. STALL             → Sell 100% si solPerMinute_1m < STALL_SOL_FLOW_MIN pendant STALL_DURATION_SECONDS
9. TIME STOP (soft)  → Sell 100% si hold > TIME_STOP_SECONDS et (pas de livePGrad ou livePGrad < TIME_STOP_MIN_PGRAD)
10. TAKE PROFIT      → Sell 50% si PnL > +50% et momentum faible
```

**Défauts code (profil Rotation §0.2) :** `TIME_STOP_SECONDS` **300**, `HARD_MAX_HOLD_SECONDS` **300**, `STALL_SOL_FLOW_MIN` **0.05**, `STALL_DURATION_SECONDS` **90**, `TIME_STOP_MIN_PGRAD` **0.5**, `EXIT_EVAL_COOLDOWN_MS` **3000**.

### Pourquoi 5 minutes (Rotation) plutôt que 10+ minutes

Les courbes qui graduent le font souvent en **5–30 min** après la zone sweet spot ; au-delà, le risque de stagnation et le **coût d’opportunité sur 5 slots** dominent. Le profil **Rotation** coupe à **300 s** (hard + soft alignés par défaut) pour forcer le recyclage du capital. Le profil **Conservation** (~600 s / stall plus lent) reste documenté en §0.2 pour runs où la pression slots est moindre.

**Note :** l’ancienne rédaction « 10 minutes » décrivait le profil Conservation ; elle n’est plus le défaut repo.

### Exit sur graduation : la stratégie 3 tranches

Seulement ~30% des tokens gradués maintiennent leur market cap sur PumpSwap. La sortie doit être agressive :

```
T1 (40%) : Vendre IMMÉDIATEMENT à graduation (même block si possible)
  → Capturer le premium pré-dump
  → Exécution via la bonding curve si encore ouverte, sinon PumpSwap

T2 (35%) : Vendre 60 secondes après graduation sur PumpSwap
  → La liquidité vient d'être créée, spread potentiellement large
  → Si prix > prix_graduation × 1.3 → hold T2 avec trailing 15%

T3 (25%) : Trailing stop de 20% depuis le peak post-graduation
  → Max hold : 5 minutes
  → Si aucun pump post-grad → sell immédiatement
```

---

## SECTION 9 : L'AVANTAGE COMPÉTITIF — MULTI-SIGNAL FUSION

### Pourquoi fusionner on-chain + social + whale = alpha

La majorité des bots Pump.fun utilisent UN seul signal :
- Les snipe bots : achètent à T=0 → espérance négative (Section 1)
- Les copy-trade bots : suivent des wallets → toujours en retard
- Les bots "KOTH" : achètent quand "King of the Hill" → c'est déjà dans le prix

**Notre edge est la FUSION de signaux indépendants.** Chaque signal seul a un pouvoir prédictif modeste. Mais la combinaison pondérée crée un signal composite dont le pouvoir prédictif est superlinéaire.

Théorème (Information théorique) :
```
Si les signaux S₁, S₂, ..., Sₙ sont partiellement indépendants :
  I(Y; S₁, ..., Sₙ) ≥ max(I(Y; Sᵢ))

L'information mutuelle du vecteur complet sur Y (graduation)
est toujours supérieure ou égale à celle du meilleur signal seul.
```

### Les 5 couches de notre avantage

```
Couche 1 : ON-CHAIN (latence < 3s)
  → Progress, velocity, acceleration, trading intensity
  → Données brutes du compte bonding curve
  → Source : BatchPoller + PumpScanner

Couche 2 : MICROSTRUCTURE (latence < 5s)  
  → Bot detection, holder distribution, HHI
  → Analyse des transactions individuelles
  → Source : VelocityAnalyzer + BotDetector

Couche 3 : WHALE INTELLIGENCE (latence < 10s)
  → Smart money entries, wallet scores, creator history
  → Base de données de baleines auto-enrichie
  → Source : WhaleWalletDB + SmartMoneyTracker

Couche 4 : SIGNAL SOCIAL (latence < 30s)
  → X/Twitter sentiment via Grok API X Search
  → Telegram channel activity
  → DexScreener boosts
  → Source : GrokXScanner + TelegramPulse + DexScreenerMonitor

Couche 5 : ML PRÉDICTIF (latence < 1ms)
  → LightGBM graduation predictor (remplace l'heuristique)
  → PPO position sizer (remplace Kelly statique)
  → ONNX inference via Rust FFI
  → Source : ModelOrchestrator
```

**L'alpha réside dans la VITESSE de fusion** — quand la couche 4 (social) confirme la couche 1 (on-chain), le signal combiné a un pouvoir prédictif ~2× supérieur à chaque couche seule. Et nous fusionnons en < 100ms, avant que la majorité des traders aient même vu le token.

---

## SECTION 10 : PROJECTIONS DE PERFORMANCE

### Simulation Monte Carlo (hypothèses conservatrices)

```
Paramètres :
  - Bankroll initial : 2 SOL
  - Tokens détectés/jour : ~500 (84/2h × 12)
  - Taux d'entrée après filtrage : 5-10% (~25-50 trades/jour)
  - Win rate (graduation ou profit > 20%) : 45% (conservateur)
  - Avg win : +120% (multiple 2.2× moins fees)
  - Avg loss : -12% (stop-loss + stall detection)
  - Position size : 0.08-0.15 SOL (Kelly quarter)

Espérance par trade :
  E[R] = 0.45 × 1.20 + 0.55 × (-0.12) = 0.54 - 0.066 = +0.474 (+47.4%)

Avec 30 trades/jour :
  E[daily PnL] = 30 × 0.10 SOL × 0.474 = +1.42 SOL/jour

Growth :
  Jour 1  : 2.00 SOL
  Jour 7  : ~5.5 SOL
  Jour 14 : ~15 SOL
  Jour 30 : ~100+ SOL (Kelly compound)
```

### Risk metrics attendues

```
  Sharpe Ratio (daily) : > 2.0 (excellent)
  Max Drawdown : < 25% (quarter-Kelly)
  Win Rate : 45-55%
  Profit Factor : > 3.0 (avg_win / avg_loss × win_rate / loss_rate)
  Avg Hold Time : 3-8 minutes
  Trades/jour : 25-50
```

### Les 3 scénarios

| Scénario | Win Rate | Avg Win | Avg Loss | E[R/trade] | Monthly |
|----------|---------|---------|---------|-----------|---------|
| Pessimiste | 35% | +80% | -15% | +17.5% | ~15 SOL |
| Base | 45% | +120% | -12% | +47.4% | ~45 SOL |
| Optimiste | 55% | +150% | -10% | +77% | ~100+ SOL |

---

## SECTION 11 : PLAN D'IMPLÉMENTATION — SÉQUENCE OPTIMALE POUR CURSOR

### Semaine 1 : Le bot qui trade (P0 → P1)

```
JOUR 1 : PositionManager.ts + ExitEngine.ts
  → Le bot sait ce qu'il possède et quand vendre
  → Test : 4h paper trading → positions ouvertes/fermées visibles

JOUR 2 : GraduationExitStrategy.ts + app.ts wiring
  → Le bot sort en 3 tranches sur graduation
  → Fix évictions TieredMonitor (30min HOT max, 2h COLD max)
  → Test : 8h paper trading → outcomes labellisés, P&L visible

JOUR 3 : EntryFilter.ts + GraduationPredictor calibration
  → Vétos V1-V5 actifs
  → Safety margin à 1.5× du breakeven
  → Target : enter rate ~10-15% au lieu de 100%
  → Test : 12h paper trading → vérifier sélectivité

JOUR 4 : WebSocketPool.ts
  → 2-3 connections (Helius × 2 + Alchemy backup)
  → Target : < 5 reconnects/heure au lieu de 167/heure
  → Test : 24h stable

JOUR 5 : Dashboard P&L dans le terminal
  → Positions ouvertes avec PnL en temps réel
  → Win rate, avg hold time, best/worst trade
  → Lancer la collecte continue 24/7
```

### Semaine 2 : Les yeux partout (P2)

```
JOUR 6-7 : GrokXScanner.ts (X/Twitter sentiment via Grok API)
  → $175/mois de crédits gratuits
  → 1 appel par token HOT → sentiment + hype + bot detection
  → Intégration dans le scoring (poids 0.07)

JOUR 8 : TelegramTokenScanner.ts + DexScreenerMonitor.ts
  → Configurer TELEGRAM_BOT_TOKEN
  → DexScreener polling (boosts + profiles, gratuit)
  → Intégration dans SentimentAggregator

JOUR 9-10 : WhaleWalletDB.ts + scripts/discover-whales.ts
  → Bootstrap depuis les graduations passées (Helius API)
  → Charger les top 500 wallets dans SmartMoneyTracker
  → Poids 0.08 dans le scoring
```

### Semaine 3 : Le cerveau ML (P3)

```
JOUR 11 : FeatureEngineer.ts (32 features)
  → Export du dataset depuis curve_snapshots + curve_outcomes
  → Vérifier qu'on a 1000+ outcomes labellisés

JOUR 12-13 : train_graduation_model.py (LightGBM)
  → AUCPR > 0.15 pour accepter le modèle
  → Feature importance : vérifier que trading_intensity est #1
  → Export ONNX

JOUR 14 : ModelOrchestrator.ts + hot-swap
  → Le modèle ML remplace l'heuristique
  → ShadowAgent compare les deux en parallèle
  → Si ML > heuristique sur 500+ décisions → promote

JOUR 15+ : PPO position sizer + retrain_pipeline actif
  → Auto-retrain toutes les 6h
  → Flywheel : plus de trades → plus de data → meilleur modèle
```

---

## SECTION 12 : VARIABLES D'ENVIRONNEMENT COMPLÈTES

```env
# ═══ Stratégie ═══
STRATEGY_MODE=curve-prediction
TRADING_MODE=paper

# ═══ Zone d'entrée (Sweet Spot) ═══
CURVE_ENTRY_MIN_PROGRESS=0.45
CURVE_ENTRY_MAX_PROGRESS=0.85
MIN_TRADING_INTENSITY=0.15
MIN_TRADE_COUNT=10
SAFETY_MARGIN_BASE=1.50

# ═══ Sortie — profil Rotation (défaut §0.2) ═══
STOP_LOSS_PCT=0.15
TRAILING_STOP_PCT=0.20
TAKE_PROFIT_PCT=0.50
TIME_STOP_SECONDS=300
HARD_MAX_HOLD_SECONDS=300
STALL_SOL_FLOW_MIN=0.05
STALL_DURATION_SECONDS=90
EXIT_EVAL_COOLDOWN_MS=3000
TIME_STOP_MIN_PGRAD=0.50
# Réservé (non lu par ExitEngine aujourd’hui — évolutions StallDetector / Tiered)
STALL_VELOCITY_THRESHOLD=0.15

# ═══ Graduation Exit (3 tranches) ═══
GRAD_T1_PCT=0.40
GRAD_T2_PCT=0.35
GRAD_T2_DELAY_MS=60000
GRAD_T3_PCT=0.25
GRAD_T3_TRAILING_STOP=0.20
GRAD_T3_MAX_HOLD_MS=300000

# ═══ Risk ═══
MAX_CONCURRENT_POSITIONS=5
MAX_TOTAL_EXPOSURE_PCT=0.25
KELLY_FRACTION=0.25
MAX_POSITION_PCT=0.10
MIN_POSITION_SOL=0.03
MAX_POSITION_SOL=0.50
DAILY_LOSS_HALT_PCT=0.15

# ═══ Vétos ═══
VETO_BOT_RATIO=0.70
VETO_CREATOR_SELLING=true
VETO_MIN_INTENSITY=0.15
VETO_MAX_AGE_MINUTES=45
VETO_MIN_FRESH_PROGRESS=0.60

# ═══ RPC ═══
HELIUS_API_KEY_1=xxx
HELIUS_API_KEY_2=xxx
ALCHEMY_API_KEY=xxx

# ═══ Social ═══
XAI_API_KEY=xxx
GROQ_API_KEY=xxx
TELEGRAM_BOT_TOKEN=xxx

# ═══ ML ═══
ONNX_GRADUATION_MODEL=models/graduation_v1.onnx
RETRAIN_INTERVAL_HOURS=6
MIN_AUCPR_THRESHOLD=0.15

# ═══ Jito ═══
JITO_BLOCK_ENGINE_URL=https://amsterdam.mainnet.block-engine.jito.wtf
JITO_TIP_LAMPORTS=50000

# ═══ Wallet ═══
WALLET_PRIVATE_KEY=xxx
PAPER_BANKROLL_SOL=2.0
```
