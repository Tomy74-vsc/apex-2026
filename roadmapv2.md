# APEX-2026 V3 — PLAN D'IMPLÉMENTATION STRATÉGIE BONDING CURVE
## Document Maître pour Cursor — Prompts Chirurgicaux

**Date :** 19 mars 2026  
**Auteur :** Lead Quant / Data Architect  
**Objectif :** Implémenter la stratégie de positionnement prédictif sur les bonding curves Pump.fun  
**Référence scientifique :** Marino et al. (arXiv:2602.14860) — "Predicting the success of new crypto-tokens"

---

## SITUATION ACTUELLE

### Ce qui EXISTE et FONCTIONNE (24/37 tickets V3)

| Module | Fichier | État |
|--------|---------|------|
| FFI Bridge Bun↔Rust | `src/bridge/RustBridge.ts` | ✅ 100ns p50 |
| Buffer Pool Anti-GC | `src/bridge/buffer-pool.ts` | ✅ 172 buffers |
| PumpScanner | `src/ingestors/PumpScanner.ts` | ✅ onLogs Pump.fun |
| MarketScanner | `src/ingestors/MarketScanner.ts` | ✅ onLogs Raydium |
| Guard | `src/detectors/Guard.ts` | ✅ Sécurité on-chain |
| DecisionCore | `src/engine/DecisionCore.ts` | ✅ Scoring + routing |
| AIBrain | `src/engine/AIBrain.ts` | ✅ 0.5ms pipeline |
| NLP Pipeline | `src/nlp/NLPPipeline.ts` | ✅ 3-stage Groq |
| ViralityScorer | `src/nlp/ViralityScorer.ts` | ✅ Time-decay |
| SmartMoneyTracker | `src/ingestors/SmartMoneyTracker.ts` | ✅ TS impl |
| OFI Calculator | `src/features/OFICalculator.ts` | ✅ TS impl |
| FeatureAssembler | `src/features/FeatureAssembler.ts` | ✅ 12-dim vector |
| HMM (fallback TS) | `src/bridge/fallback.ts` | ✅ FallbackBridge |
| Hawkes (TS) | `src/engine/HawkesEvaluator.ts` | ✅ Ring buffer 1024 |
| Kelly Engine | `src/risk/KellyEngine.ts` | ✅ f* dynamic |
| CVaR Manager | `src/risk/CVaRManager.ts` | ✅ Tail risk |
| Feature Store | `src/data/FeatureStore.ts` | ✅ SQLite 451 lignes |
| OutcomeTracker | `src/engine/OutcomeTracker.ts` | ✅ Labeling T+5/30min |
| Reward Logger | `src/engine/RewardLogger.ts` | ✅ R_i calc |
| Shadow Agent | `src/engine/ShadowAgent.ts` | ✅ Parallel eval |
| Model Updater | `src/engine/ModelUpdater.ts` | ✅ Hot-swap |
| PPO Agent | `python/rl/ppo_agent.py` | ✅ Training ready |
| Retrain Pipeline | `python/retrain_pipeline.py` | ✅ Auto-retrain |

### Ce qui doit être CRÉÉ (nouvelle stratégie Bonding Curve)

| Module | Fichier | Priorité |
|--------|---------|----------|
| Constantes Pump.fun | `src/constants/pumpfun.ts` | 🔴 P0 — Fondation |
| Types Bonding Curve | `src/types/bonding-curve.ts` | 🔴 P0 — Fondation |
| Maths Bonding Curve | `src/math/curve-math.ts` | 🔴 P0 — Fondation |
| CurveTracker | `src/modules/curve-tracker/CurveTracker.ts` | 🔴 P1 — Core |
| TieredMonitor | `src/modules/curve-tracker/TieredMonitor.ts` | 🔴 P1 — Core |
| BatchPoller | `src/modules/curve-tracker/BatchPoller.ts` | 🔴 P1 — Core |
| VelocityAnalyzer | `src/modules/graduation-predictor/VelocityAnalyzer.ts` | 🔴 P2 — Signaux |
| BotDetector (curve) | `src/modules/graduation-predictor/BotDetector.ts` | 🟡 P2 — Signaux |
| WalletScorer | `src/modules/graduation-predictor/WalletScorer.ts` | 🟡 P2 — Signaux |
| HolderDistribution | `src/modules/graduation-predictor/HolderDistribution.ts` | 🟡 P2 — Signaux |
| BreakevenCurve | `src/modules/graduation-predictor/BreakevenCurve.ts` | 🔴 P2 — Signaux |
| GraduationPredictor | `src/modules/graduation-predictor/GraduationPredictor.ts` | 🔴 P3 — Prédiction |
| CurveExecutor | `src/modules/curve-executor/CurveExecutor.ts` | 🔴 P3 — Exécution |
| JitoBundler (curve) | `src/modules/curve-executor/JitoBundler.ts` | 🔴 P3 — Exécution |
| StallDetector | `src/modules/risk/StallDetector.ts` | 🟡 P4 — Risk |
| PortfolioGuard | `src/modules/risk/PortfolioGuard.ts` | 🟡 P4 — Risk |
| GraduationExitStrategy | `src/modules/curve-executor/GraduationExitStrategy.ts` | 🟡 P4 — Risk |

### Ce qui doit être MODIFIÉ

| Module | Modification |
|--------|-------------|
| `PumpScanner.ts` | Émettre `onCurveCreate` au lieu de trade immédiat → enregistre dans CurveTracker |
| `DecisionCore.ts` | Routing vers CurveTracker au lieu de Guard direct. Nouveau mode `curve-prediction` |
| `AIBrain.ts` | Nouveau action space : `ENTER_CURVE / EXIT_CURVE / HOLD / SKIP` |
| `FeatureAssembler.ts` | Étendre avec 30+ features bonding curve (CurveFeatureVector) |
| `KellyEngine.ts` | Sizing basé sur P(graduation) au lieu de score linéaire |
| `Guard.ts` | Ajouter guards curve-specific : `isStalled`, `isMaxExposure`, `isCurveComplete` |
| `src/types/index.ts` | Ajouter les nouvelles interfaces |
| `FeatureStore.ts` | Nouveau schéma pour données bonding curve |

---

## ORDRE D'IMPLÉMENTATION (Graphe de Dépendances)

```
SPRINT 1 (Semaine 1-2) — FONDATION ON-CHAIN
═══════════════════════════════════════════
  P0.1 pumpfun.ts (constantes)           ← aucune dépendance
  P0.2 bonding-curve.ts (types+decoder)  ← P0.1
  P0.3 curve-math.ts (maths AMM)         ← P0.1
  P0.4 test-curve-decode.ts (validation) ← P0.1 + P0.2 + P0.3
      │
      ▼
  P1.1 BatchPoller.ts                    ← P0.2
  P1.2 TieredMonitor.ts                  ← P1.1
  P1.3 CurveTracker.ts                   ← P1.1 + P1.2
  P1.4 PumpScanner.ts (MODIFICATION)     ← P1.3

SPRINT 2 (Semaine 3-4) — PIPELINE DE SIGNAUX
═══════════════════════════════════════════
  P2.1 VelocityAnalyzer.ts               ← P1.3
  P2.2 BotDetector.ts (curve)            ← P1.3
  P2.3 WalletScorer.ts                   ← SmartMoneyTracker existant
  P2.4 HolderDistribution.ts             ← P1.3
  P2.5 BreakevenCurve.ts                 ← P0.3
  P2.6 FeatureAssembler.ts (MODIF)       ← P2.1-P2.5
  P2.7 FeatureStore.ts (MODIF schema)    ← P2.6
      │
      ▼
SPRINT 3 (Semaine 5-6) — PRÉDICTION + EXÉCUTION
═══════════════════════════════════════════
  P3.1 GraduationPredictor.ts            ← P2.1-P2.5
  P3.2 CurveExecutor.ts                  ← P0.1 + P0.3
  P3.3 JitoBundler.ts (curve)            ← P3.2
  P3.4 AIBrain.ts (MODIFICATION)         ← P3.1
  P3.5 DecisionCore.ts (MODIFICATION)    ← P3.1 + P3.4
  P3.6 Guard.ts (MODIFICATION)           ← P1.3
      │
      ▼
SPRINT 4 (Semaine 7-8) — RISK MANAGEMENT + LIVE
═══════════════════════════════════════════
  P4.1 StallDetector.ts                  ← P2.1
  P4.2 PortfolioGuard.ts                 ← P3.2
  P4.3 GraduationExitStrategy.ts         ← P3.2 + P4.1
  P4.4 KellyEngine.ts (MODIFICATION)     ← P3.1
  P4.5 app.ts (MODIFICATION)             ← TOUT
```

---

## SPRINT 1 — FONDATION ON-CHAIN

### MODULE P0.1 : Constantes Pump.fun

**Fichier :** `src/constants/pumpfun.ts`  
**Dépendances :** Aucune  
**Estimation :** 0.5 jour

#### PROMPT CHIRURGICAL POUR CURSOR

```
OBJECTIF : Créer le fichier de constantes pour le programme Pump.fun on-chain.

@file src/constants/pumpfun.ts (NOUVEAU)

Crée un fichier TypeScript avec TOUTES les constantes nécessaires pour interagir 
avec le programme Pump.fun sur Solana mainnet. Ce fichier est la source unique de 
vérité pour tous les modules du projet.

CONSTANTES REQUISES :

1. Program IDs (PublicKey) :
   - PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
   - PUMPSWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
   - FEE_PROGRAM_ID = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
   
2. Comptes système :
   - GLOBAL_ACCOUNT = "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"
   - FEE_RECIPIENT = "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"
   - WITHDRAW_AUTHORITY = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg"
   - EVENT_AUTHORITY = PDA dérivé de ["__event_authority", PUMP_PROGRAM_ID]

3. Paramètres de la bonding curve (bigint) :
   - INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n (1.073B, 6 decimals)
   - INITIAL_VIRTUAL_SOL_RESERVES = 30_000_000_000n (30 SOL en lamports)
   - INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n (793.1M tradeable)
   - TOKEN_TOTAL_SUPPLY = 1_000_000_000_000_000n (1B total)
   - GRADUATION_REAL_SOL_THRESHOLD = 85_000_000_000n (~85 SOL)
   - FEE_BASIS_POINTS = 125n (1.25% total fee)

4. Discriminateurs d'instructions (Uint8Array) :
   - BUY_DISCRIMINATOR = [102, 6, 61, 18, 1, 218, 235, 234]
   - BUY_EXACT_SOL_DISCRIMINATOR = [56, 252, 116, 8, 158, 223, 205, 95]
   - SELL_DISCRIMINATOR = [51, 230, 133, 164, 1, 127, 131, 173]
   - CREATE_DISCRIMINATOR = [24, 30, 200, 40, 5, 28, 7, 119]

5. Discriminateur du compte BondingCurve :
   - BONDING_CURVE_DISCRIMINATOR = [0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60]
   - BONDING_CURVE_ACCOUNT_SIZE = 82 (bytes, sans discriminateur = 90 total)

6. Seuils stratégiques (number, en SOL) :
   - KOTH_SOL_THRESHOLD = 32 (King of the Hill ~52%)
   - ENTRY_ZONE_START_SOL = 35 (~55% progress)
   - ENTRY_ZONE_END_SOL = 55 (~75% progress)
   - GRADUATION_SOL = 85

7. Constantes de timing :
   - COLD_POLL_INTERVAL_MS = 60_000
   - WARM_POLL_INTERVAL_MS = 10_000
   - HOT_POLL_INTERVAL_MS = 3_000
   - STALE_CURVE_TTL_MS = 86_400_000 (24h)
   - MAX_CURVE_HOLD_TIME_MS = 7_200_000 (2h)

RÈGLES :
- Utiliser PublicKey de @solana/web3.js pour tous les comptes
- Tous les montants SOL en LAMPORTS (bigint) sauf les seuils stratégiques
- Exporter tout comme const avec typage strict
- Ajouter un commentaire JSDoc pour chaque constante avec sa source
- NE PAS hardcoder de clés privées ou secrets
```

---

### MODULE P0.2 : Types et Décodeur Bonding Curve

**Fichier :** `src/types/bonding-curve.ts`  
**Dépendances :** P0.1  
**Estimation :** 0.5 jour

#### PROMPT CHIRURGICAL POUR CURSOR

```
OBJECTIF : Créer les interfaces TypeScript et le décodeur pour lire l'état 
on-chain des bonding curves Pump.fun.

@file src/types/bonding-curve.ts (NOUVEAU)
@file src/constants/pumpfun.ts (référence)

INTERFACES À CRÉER :

1. BondingCurveState — état brut du compte on-chain (82 bytes après discriminateur) :
   - virtualTokenReserves: bigint    (offset 0x00, u64 LE)
   - virtualSolReserves: bigint      (offset 0x08, u64 LE)
   - realTokenReserves: bigint       (offset 0x10, u64 LE)
   - realSolReserves: bigint         (offset 0x18, u64 LE)
   - tokenTotalSupply: bigint        (offset 0x20, u64 LE)
   - complete: boolean               (offset 0x28, u8 == 1)
   - creator: PublicKey              (offset 0x29, 32 bytes)
   - isMayhemMode: boolean           (offset 0x49, u8 == 1)

2. TrackedCurve — état enrichi pour le monitoring :
   - mint: string
   - bondingCurvePDA: PublicKey
   - state: BondingCurveState
   - progress: number               (0.0 - 1.0)
   - realSolSOL: number             (realSolReserves converti en SOL)
   - priceSOL: number               (prix actuel en SOL)
   - marketCapSOL: number
   - isKOTH: boolean                (King of the Hill atteint)
   - createdAt: number              (Unix ms)
   - lastUpdated: number            (Unix ms)
   - tier: 'cold' | 'warm' | 'hot'
   - tradeCount: number
   - metadata: { name?: string; symbol?: string; uri?: string }

3. CurveTradeEvent — événement de trade sur la courbe :
   - mint: string
   - isBuy: boolean
   - solAmount: number              (en SOL, pas lamports)
   - tokenAmount: bigint
   - trader: string
   - slot: number
   - timestamp: number
   - signature: string

4. GraduationEvent — quand complete passe à true :
   - mint: string
   - totalSolRaised: number
   - tradeDuration_s: number        (temps depuis création)
   - finalTradeCount: number

FONCTIONS À IMPLÉMENTER :

function decodeBondingCurve(data: Buffer): BondingCurveState
  - Skip les 8 premiers bytes (discriminateur)
  - Lire chaque champ avec readBigUInt64LE aux offsets corrects
  - Construire PublicKey à partir de data.subarray(49, 81)
  - Valider que le discriminateur matche BONDING_CURVE_DISCRIMINATOR
  - Lancer une erreur si le buffer fait < 90 bytes

function deriveBondingCurvePDA(mint: PublicKey): [PublicKey, number]
  - Seeds : [Buffer.from("bonding-curve"), mint.toBuffer()]
  - Program : PUMP_PROGRAM_ID
  - Utiliser PublicKey.findProgramAddressSync

function deriveAssociatedBondingCurve(mint: PublicKey, curvePDA: PublicKey): PublicKey
  - Utiliser getAssociatedTokenAddressSync(mint, curvePDA, true)

RÈGLES :
- Pas de 'any' — typage strict
- Tous les bigint restent bigint dans BondingCurveState (pas de conversion)
- Les conversions SOL se font dans TrackedCurve uniquement
- Ajouter des tests inline avec Bun.test pour le décodeur
```

---

### MODULE P0.3 : Mathématiques de la Bonding Curve

**Fichier :** `src/math/curve-math.ts`  
**Dépendances :** P0.1  
**Estimation :** 0.5 jour

#### PROMPT CHIRURGICAL POUR CURSOR

```
OBJECTIF : Implémenter toutes les formules mathématiques du constant-product AMM 
de Pump.fun. Ce module est sur le HOT PATH — chaque fonction doit être < 1μs.

@file src/math/curve-math.ts (NOUVEAU)
@file src/constants/pumpfun.ts (référence)

La bonding curve Pump.fun est un AMM constant-product :
  virtualSol × virtualToken = k (invariant)
  k = INITIAL_VIRTUAL_SOL_RESERVES × INITIAL_VIRTUAL_TOKEN_RESERVES

FONCTIONS À IMPLÉMENTER (toutes en bigint pour éviter les erreurs de précision) :

1. calcProgress(realTokenReserves: bigint): number
   - progress = 1 - (realTokenReserves / INITIAL_REAL_TOKEN_RESERVES)
   - Si realTokenReserves >= INITIAL_REAL_TOKEN_RESERVES → return 0
   - Si realTokenReserves <= 0n → return 1.0
   - Retourne un number entre 0.0 et 1.0

2. calcPricePerToken(vSol: bigint, vToken: bigint): number
   - price = Number(vSol) / Number(vToken)
   - En SOL par token (unités brutes, 9 decimals SOL / 6 decimals token)

3. calcMarketCapSOL(vSol: bigint, vToken: bigint): number
   - mcap = (vSol × TOKEN_TOTAL_SUPPLY) / vToken
   - Convertir en SOL : Number(mcap) / 1e9

4. calcBuyOutput(vSol: bigint, vToken: bigint, solInLamports: bigint): bigint
   - Appliquer fee : solAfterFee = solInLamports × (10000n - FEE_BASIS_POINTS) / 10000n
   - k = vSol × vToken
   - newVSol = vSol + solAfterFee
   - newVToken = k / newVSol (division entière bigint)
   - tokensOut = vToken - newVToken
   - RETOURNER tokensOut (nombre de tokens reçus)

5. calcSellOutput(vSol: bigint, vToken: bigint, tokenIn: bigint): bigint
   - k = vSol × vToken
   - newVToken = vToken + tokenIn
   - newVSol = k / newVToken
   - grossSol = vSol - newVSol
   - solOut = grossSol × (10000n - FEE_BASIS_POINTS) / 10000n
   - RETOURNER solOut (lamports de SOL reçus)

6. calcRequiredSolForProgress(targetProgress: number): bigint
   - Inverse de calcProgress : combien de SOL pour atteindre un % donné
   - targetRealTokenReserves = INITIAL_REAL_TOKEN_RESERVES × (1 - targetProgress)
   - targetVToken = targetRealTokenReserves + INITIAL_VIRTUAL_TOKEN_RESERVES - 
                    INITIAL_REAL_TOKEN_RESERVES
   - targetVSol = k / targetVToken
   - realSolNeeded = targetVSol - INITIAL_VIRTUAL_SOL_RESERVES
   - Ajuster pour les fees

7. calcPriceImpact(vSol: bigint, vToken: bigint, solIn: bigint): number
   - priceBefore = calcPricePerToken(vSol, vToken)
   - tokensOut = calcBuyOutput(vSol, vToken, solIn)
   - priceAfter = calcPricePerToken(vSol + solIn, vToken - tokensOut)
   - impact = (priceAfter - priceBefore) / priceBefore
   - Retourne un nombre positif (ex: 0.05 = 5% d'impact)

8. calcExpectedReturnOnGraduation(currentRealSol: bigint): number
   - entryPrice = calcPricePerToken(currentVSol, currentVToken)
   - gradPrice = calcPricePerToken(115_000_000_000n, gradVToken)
   - return gradPrice / entryPrice  (multiple, ex: 1.5 = +50%)

TESTS OBLIGATOIRES (avec Bun.test dans le même fichier ou fichier séparé) :
- calcProgress(INITIAL_REAL_TOKEN_RESERVES) === 0
- calcProgress(0n) === 1.0
- calcProgress avec 50% des tokens vendus ≈ 0.5
- calcBuyOutput avec 1 SOL puis calcSellOutput du résultat ≈ 1 SOL - fees
- calcExpectedReturnOnGraduation à 50% progress ≈ 1.4-1.7x

CONTRAINTES HOT PATH :
- Pas d'allocation mémoire (pas de new, pas de spread)
- Pas de conversion Number ↔ BigInt sauf dans les retours finaux
- Pas de division par zéro : guard toutes les divisions
```

---

### MODULE P0.4 : Script de Validation Live

**Fichier :** `scripts/test-curve-decode.ts`  
**Dépendances :** P0.1 + P0.2 + P0.3  
**Estimation :** 0.5 jour

#### PROMPT CHIRURGICAL POUR CURSOR

```
OBJECTIF : Script de test qui se connecte au mainnet, récupère l'état d'une 
bonding curve Pump.fun en live, et valide que notre décodeur fonctionne.

@file scripts/test-curve-decode.ts (NOUVEAU)
@file src/constants/pumpfun.ts
@file src/types/bonding-curve.ts
@file src/math/curve-math.ts

Le script doit :

1. Accepter un mint address en argument : bun scripts/test-curve-decode.ts <MINT>
   Si pas d'argument, utiliser un token Pump.fun récent (trouver via logsSubscribe)

2. Dériver le PDA de la bonding curve depuis le mint

3. Fetch le compte via connection.getAccountInfo(curvePDA)

4. Décoder avec decodeBondingCurve()

5. Afficher :
   - Mint
   - Bonding Curve PDA
   - Virtual Token Reserves
   - Virtual SOL Reserves  
   - Real Token Reserves
   - Real SOL Reserves (en SOL)
   - Progress : XX.X%
   - Prix actuel : X.XXXXXXXX SOL/token
   - Market Cap : XXX SOL
   - Completed : true/false
   - Creator : PublicKey
   - Est KOTH : true/false (>= 32 SOL real)
   - Expected return at graduation : X.Xx

6. Si le token est actif (non complete), faire un calcBuyOutput pour 0.1 SOL 
   et afficher les tokens qu'on recevrait

7. Benchmarker le temps de décodage (performance.now) sur 10000 itérations
   pour vérifier < 1μs par décodage

8. Mode watch (--watch) : poll toutes les 3s et afficher les changements

UTILISER :
- process.env.HELIUS_RPC_URL pour le RPC
- Commitment 'confirmed' pour le fetch
- Console avec émojis (📊 🎯 ⏱️)
```

---

### MODULE P1.1 : BatchPoller

**Fichier :** `src/modules/curve-tracker/BatchPoller.ts`  
**Dépendances :** P0.2  
**Estimation :** 1 jour

#### PROMPT CHIRURGICAL POUR CURSOR

```
OBJECTIF : Module qui poll l'état de centaines de bonding curves simultanément 
via getMultipleAccounts (batches de 100 comptes max par appel RPC).

@file src/modules/curve-tracker/BatchPoller.ts (NOUVEAU)
@file src/types/bonding-curve.ts
@file src/constants/pumpfun.ts
@file src/bridge/buffer-pool.ts (réutiliser le pattern anti-GC)

CLASSE BatchPoller extends EventEmitter :

Propriétés :
  - connection: Connection (du RPC)
  - tracked: Map<string, PublicKey> (mint → bondingCurvePDA)
  - pollIntervals: Map<string, ReturnType<typeof setInterval>>

Méthodes :

  register(mint: string, bondingCurvePDA: PublicKey): void
    - Ajouter à la map tracked

  unregister(mint: string): void
    - Retirer de tracked, clear l'interval si existant

  async pollBatch(mints: string[]): Promise<Map<string, BondingCurveState | null>>
    - Récupérer les PDAs correspondantes
    - Découper en batches de 100 (getMultipleAccounts limite)
    - Pour chaque batch : connection.getMultipleAccountsInfo(batch)
    - Décoder chaque compte avec decodeBondingCurve
    - Émettre 'stateUpdate' pour chaque curve avec (mint, state)
    - Si state.complete === true → émettre 'graduated' avec le mint
    - try/catch silencieux : ne JAMAIS crasher sur un compte manquant
    - Mesurer et logger le temps total : "📊 Polled {N} curves in {X}ms"

  async pollAll(): Promise<void>
    - Appeler pollBatch avec tous les mints de tracked
    - Utiliser RPC Racing si QUICKNODE_RPC_URL disponible

  getTrackedCount(): number

Événements émis :
  - 'stateUpdate': (mint: string, state: BondingCurveState, prevState?: BondingCurveState)
  - 'graduated': (mint: string, state: BondingCurveState)
  - 'error': (error: Error)

OPTIMISATIONS :
  - Réutiliser le même Connection object (pas de new Connection par poll)
  - Promise.any sur [heliusConnection, quicknodeConnection] pour RPC racing
  - Timeout 5s par batch via AbortController
  - Cache le dernier état connu pour détecter les changements (n'émettre que si 
    realSolReserves a changé)

RATE LIMITS :
  - Max 10 batches par poll (= 1000 curves max)
  - Delay 100ms entre chaque batch pour respecter les rate limits free tier
  - Si 429 reçu → backoff exponentiel (1s, 2s, 4s, max 30s)
```

---

### MODULE P1.2 : TieredMonitor

**Fichier :** `src/modules/curve-tracker/TieredMonitor.ts`  
**Dépendances :** P1.1  
**Estimation :** 1 jour

#### PROMPT CHIRURGICAL POUR CURSOR

```
OBJECTIF : Gestionnaire de lifecycle qui classe les bonding curves en 3 tiers 
(Cold/Warm/Hot) et ajuste la fréquence de polling selon la progression.

@file src/modules/curve-tracker/TieredMonitor.ts (NOUVEAU)
@file src/modules/curve-tracker/BatchPoller.ts
@file src/types/bonding-curve.ts
@file src/constants/pumpfun.ts
@file src/math/curve-math.ts

CLASSE TieredMonitor extends EventEmitter :

Tiers :
  - COLD  (<25% progress) : poll toutes les 60s, collecte passive
  - WARM  (25-50% progress) : poll toutes les 10s, début qualification
  - HOT   (>50% progress) : poll toutes les 3s, signaux d'entrée actifs

Propriétés :
  - cold: Map<string, TrackedCurve>
  - warm: Map<string, TrackedCurve>
  - hot: Map<string, TrackedCurve>
  - batchPoller: BatchPoller
  - coldInterval / warmInterval / hotInterval : timers

Méthodes :

  register(mint: string, bondingCurvePDA: PublicKey, creator: PublicKey): void
    - Créer TrackedCurve avec état initial
    - Ajouter en tier COLD
    - Enregistrer dans BatchPoller

  private promoteCurve(mint: string, newProgress: number): void
    - Si progress >= 0.50 et pas déjà en HOT :
      → Déplacer de warm/cold vers hot
      → Émettre 'enterHotZone' (DÉCLENCHE les analyses lourdes)
      → Logger "🔥 [TieredMonitor] {mint} entered HOT zone ({progress}%)"
    - Si progress >= 0.25 et < 0.50 :
      → Déplacer de cold vers warm
      → Émettre 'enterWarmZone' (DÉCLENCHE qualification légère)
      → Logger "⚠️ [TieredMonitor] {mint} promoted to WARM ({progress}%)"

  private demoteOrEvict(mint: string): void
    - Si token en COLD et > 24h et progress < 10% → EVICT (supprimer)
    - Si token en WARM et > 6h sans changement → demote to COLD
    - Si token graduated (complete) → EVICT et émettre 'graduated'

  private onStateUpdate(mint: string, state: BondingCurveState): void
    - Calculer progress via calcProgress
    - Mettre à jour TrackedCurve
    - Appeler promoteCurve si besoin
    - Appeler demoteOrEvict si besoin
    - Émettre 'curveUpdate' avec l'état enrichi

  start(): void
    - Démarrer les 3 intervals de polling
    - Cold : poll toutes les COLD_POLL_INTERVAL_MS
    - Warm : poll toutes les WARM_POLL_INTERVAL_MS
    - Hot : poll toutes les HOT_POLL_INTERVAL_MS
    - Écouter BatchPoller 'stateUpdate' → onStateUpdate

  stop(): void
    - Clear tous les intervals

  getStats(): { cold: number, warm: number, hot: number, total: number }

Événements émis :
  - 'enterHotZone': (mint: string, curve: TrackedCurve) ← SIGNAL CRITIQUE
  - 'enterWarmZone': (mint: string, curve: TrackedCurve)
  - 'curveUpdate': (mint: string, curve: TrackedCurve)
  - 'graduated': (mint: string, curve: TrackedCurve)
  - 'evicted': (mint: string, reason: string)

MÉMOIRE :
  - TrackedCurve ≈ 200 bytes par curve
  - 1000 curves = 200 KB
  - Limiter cold à 5000 max, warm à 500 max, hot à 100 max
  - Au-delà → evict les plus anciens du tier le plus bas
```

---

### MODULE P1.3 : CurveTracker (Orchestrateur)

**Fichier :** `src/modules/curve-tracker/CurveTracker.ts`  
**Dépendances :** P1.1 + P1.2  
**Estimation :** 1 jour

#### PROMPT CHIRURGICAL POUR CURSOR

```
OBJECTIF : Module principal qui orchestre le suivi des bonding curves. 
C'est le point d'entrée unique pour le reste du pipeline.

@file src/modules/curve-tracker/CurveTracker.ts (NOUVEAU)
@file src/modules/curve-tracker/TieredMonitor.ts
@file src/modules/curve-tracker/BatchPoller.ts
@file src/types/bonding-curve.ts
@file src/math/curve-math.ts

CLASSE CurveTracker extends EventEmitter (Singleton via getCurveTracker()) :

Propriétés :
  - tieredMonitor: TieredMonitor
  - tradeHistory: Map<string, CurveTradeEvent[]> (historique par mint)
  - readonly MAX_TRADE_HISTORY = 500 (par token)

Méthodes publiques :

  async start(): void
    - Initialiser BatchPoller avec les connections RPC
    - Initialiser TieredMonitor
    - S'abonner aux événements du TieredMonitor
    - Démarrer le TieredMonitor
    - Logger "🚀 [CurveTracker] Started — monitoring bonding curves"

  registerNewCurve(mint: string, creator: string): void
    - Dériver le PDA
    - Enregistrer dans TieredMonitor
    - Initialiser le tradeHistory vide pour ce mint
    - Logger "📝 [CurveTracker] Registered {mint.slice(0,8)}..."

  recordTrade(event: CurveTradeEvent): void
    - Ajouter au tradeHistory du mint
    - Si > MAX_TRADE_HISTORY → shift() les plus anciens
    - Incrémenter le tradeCount du TrackedCurve

  getTradeHistory(mint: string): CurveTradeEvent[]
  getCurveState(mint: string): TrackedCurve | null
  getHotCurves(): TrackedCurve[]
  
  async stop(): void

Ce module RE-ÉMET les événements critiques du TieredMonitor :
  - 'enterHotZone' → c'est le TRIGGER pour le GraduationPredictor
  - 'graduated' → c'est le TRIGGER pour la GraduationExitStrategy
  - 'curveUpdate' → pour le logging dans FeatureStore

INTÉGRATION AVEC PumpScanner (MODIFICATION de PumpScanner.ts) :
  - PumpScanner détecte toujours les créations via onLogs
  - Au lieu de déclencher Guard immédiatement :
    → Appeler curveTracker.registerNewCurve(mint, creator)
    → Le suivi commence en tier COLD
  - Les trades détectés par le scanner → curveTracker.recordTrade()
```

---

### MODIFICATION P1.4 : PumpScanner

#### PROMPT CHIRURGICAL POUR CURSOR

```
OBJECTIF : Modifier PumpScanner pour qu'il enregistre les nouvelles créations 
dans le CurveTracker au lieu de les traiter immédiatement.

@file src/ingestors/PumpScanner.ts (MODIFICATION)
@file src/modules/curve-tracker/CurveTracker.ts

CHANGEMENTS :

1. Dans handleLogs() ou handleNewPool() :
   AVANT : await this.decisionCore.processMarketEvent(event, isFastCheck)
   APRÈS : 
     // Enregistrer dans le CurveTracker pour monitoring passif
     const curveTracker = getCurveTracker();
     curveTracker.registerNewCurve(event.token.mint, creatorAddress);
     // Émettre l'événement pour le dashboard
     this.emit('newLaunch', event);

2. Quand le scanner détecte un trade sur une curve Pump.fun :
   → Parser le trade (isBuy, solAmount, trader)
   → curveTracker.recordTrade({ mint, isBuy, solAmount, ... })

3. GARDER le mode FastCheck mais le rediriger vers le CurveTracker :
   → Si liquidité > KOTH_SOL_THRESHOLD (32 SOL) :
     curveTracker.promoteCurve(mint) // force en tier HOT

4. NE PAS supprimer le code existant — l'encapsuler dans un if :
   if (process.env.STRATEGY_MODE === 'curve-prediction') {
     // Nouveau pipeline CurveTracker
   } else {
     // Ancien pipeline (snipe à T=0) pour backward compatibility
   }

5. Ajouter dans .env : STRATEGY_MODE=curve-prediction
```

---

## SPRINT 2 — PIPELINE DE SIGNAUX (Prompts résumés)

### P2.1 VelocityAnalyzer

```
@file src/modules/graduation-predictor/VelocityAnalyzer.ts (NOUVEAU)
@file src/modules/curve-tracker/CurveTracker.ts

SIGNAL #1 DU PAPIER ARXIV (le plus prédictif).
Calcule la vitesse d'accumulation de SOL dans la bonding curve.

Métriques :
- solPerMinute_5m : SOL/min sur 5min glissantes
- solPerMinute_1m : SOL/min sur 1min
- avgTradeSize_SOL : taille moyenne des buys (CRITIQUE : plus gros = meilleur)
- tradesToReachCurrentLevel : nombre total de buys (moins = meilleur)
- velocityAcceleration : d²(SOL)/dt² (positif = accélère)
- velocityRatio : current_velocity / peak_velocity (> 0.7 = momentum fort)
- peakVelocity_5m : max SOL/min dans les 5 dernières minutes
```

### P2.2 BotDetector (Curve-Specific)

```
@file src/modules/graduation-predictor/BotDetector.ts (NOUVEAU)

SIGNAL #3 DU PAPIER ARXIV (négatif — plus de bots = moins de graduation).

Heuristiques :
- freshWalletRatio : % de buyers avec wallet < 24h
- uniformTradeSizeRatio : % de trades avec montant identique (± 0.01 SOL)
- sameBlockBuyCount : nombre de buys dans le même slot
- botTransactionRatio : score composite 0-1

VÉTO : si botTransactionRatio > 0.7 → SKIP automatique
```

### P2.3 WalletScorer

```
@file src/modules/graduation-predictor/WalletScorer.ts (NOUVEAU)
@file src/ingestors/SmartMoneyTracker.ts (existant, référence)

SIGNAL #2 DU PAPIER (modeste mais utile).

- smartMoneyBuyerCount : combien de wallets avec historique profitable
- smartMoneySOLTotal : SOL total des smart money
- creatorHistoricalGradRate : taux de graduation des tokens précédents du creator
- creatorTokenCount : combien de tokens le creator a lancé (beaucoup = mauvais)
- creatorIsSelling : le creator vend-il pendant la courbe ? (RED FLAG absolu)
- freshWalletRatio : % de wallets neuves (clustering sybil)

Utilise SmartMoneyTracker.ts existant pour les données de wallets.
```

### P2.5 BreakevenCurve

```
@file src/modules/graduation-predictor/BreakevenCurve.ts (NOUVEAU)
@file src/math/curve-math.ts

Le seuil minimum de P(graduation) pour que l'entrée soit profitable.

minPGrad(realSol) = (priceAtEntry × 1.025) / priceAtGraduation
  - Le 1.025 = 2.5% de fees aller-retour

À 50% progress (~28 SOL) : breakeven ≈ 51%
À 60% progress (~42 SOL) : breakeven ≈ 65%  
À 75% progress (~55 SOL) : breakeven ≈ 78%

SWEET SPOT : entrer là où pGrad_estimé > breakeven × 1.2 (marge de 20%)
```

---

## SPRINT 3 — PRÉDICTION + EXÉCUTION (Prompts résumés)

### P3.1 GraduationPredictor

```
@file src/modules/graduation-predictor/GraduationPredictor.ts (NOUVEAU)

Système à 2 étages :

ÉTAGE 1 (Heuristique rapide, < 1ms) :
  VÉTOS automatiques :
  - avgTradeSize < 0.3 SOL → SKIP (pas assez d'engagement)
  - botRatio > 0.7 → SKIP (manipulation)
  - creatorIsSelling → SKIP (rug incoming)
  - velocityRatio < 0.2 → SKIP (momentum mort)

ÉTAGE 2 (Modèle ML — XGBoost ou ONNX) :
  Input : CurveFeatureVector (30+ features)
  Output : pGrad (0.0 - 1.0), confidence (0.0 - 1.0)
  
  En attendant le modèle ML, utiliser un SCORE PONDÉRÉ :
  pGrad = 
    0.40 × velocityScore +      (normaliser solPerMinute_1m)
    0.20 × (1 - botRatio) +     (moins de bots = meilleur)
    0.15 × smartMoneyScore +    (normaliser smartMoneyBuyerCount)
    0.15 × holderDiversityScore +(normaliser HHI inversé)
    0.10 × socialScore           (ViralityScorer existant)

  Seuil d'entrée : pGrad > breakeven × 1.2
```

### P3.2 CurveExecutor

```
@file src/modules/curve-executor/CurveExecutor.ts (NOUVEAU)

Achète et vend directement sur la bonding curve Pump.fun.
PAS via Jupiter — interaction directe avec le programme Pump.fun.

BUY instruction :
  - Discriminateur : [102, 6, 61, 18, 1, 218, 235, 234]
  - Args : amount (u64 tokens), maxSolCost (u64 lamports)
  - 15 comptes nécessaires (voir le plan d'implémentation PDF)

SELL instruction :
  - Discriminateur : [51, 230, 133, 164, 1, 127, 131, 173]
  - Args : amount (u64 tokens), minSolOutput (u64 lamports)

Utiliser Jito bundles pour l'inclusion garantie.
SDK recommandé : construire les instructions manuellement avec les discriminateurs.
```

---

## RÉSUMÉ — PREMIER MODULE À CODER

Le premier module critique est **P0.1 + P0.2 + P0.3** (les fondations on-chain), car TOUT le reste en dépend. Sans pouvoir décoder l'état d'une bonding curve, aucun tracking, aucune prédiction, aucune exécution n'est possible.

**Commencer par copier le prompt P0.1 dans Cursor**, puis P0.2, puis P0.3, puis P0.4 pour valider en live.

Une fois Sprint 1 complété, le bot peut commencer à collecter des données sur les progressions de bonding curves — ce qui est nécessaire pour entraîner le modèle ML du GraduationPredictor.

---

## VARIABLES D'ENVIRONNEMENT À AJOUTER

```env
# Nouvelle stratégie
STRATEGY_MODE=curve-prediction

# Seuils d'entrée (SOL dans la courbe)
CURVE_ENTRY_MIN_PROGRESS=0.50
CURVE_ENTRY_MAX_PROGRESS=0.80
CURVE_MIN_PGRAD=0.55

# Risk management
MAX_CONCURRENT_CURVE_POSITIONS=5
MAX_TOTAL_CURVE_EXPOSURE_PCT=0.20
MAX_HOLD_TIME_MINUTES=120
DAILY_LOSS_LIMIT_PCT=0.05

# Position sizing
KELLY_FRACTION=0.25
MAX_POSITION_PCT=0.05
MIN_POSITION_SOL=0.05
```