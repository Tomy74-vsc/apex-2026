# APEX-2026 — DIRECTIVE CURSOR COMPOSER ULTIME
## Fortification Curve Strategy + Suppression Sniper + Fix Bugs Audit
**Date :** 24 mars 2026  
**Auteur :** Lead Quant Architect  
**Objectif :** Passer de ~10% WR → 45%+ WR en blindant l'analyse complète de chaque token dans la stratégie curve. Supprimer le sniper. Corriger tous les bugs de l'audit.

---

> **COMMENT UTILISER CE FICHIER :**  
> Copie chaque bloc `PROMPT CURSOR N` séparément dans Cursor Composer.  
> Exécute-les **dans l'ordre numérique**. Chaque prompt est indépendant mais dépend des précédents.  
> Valide avec `bun run typecheck` après chaque prompt.

---

## CONTEXTE GLOBAL (à lire avant tout)

Le bot tourne en mode `curve-prediction` (bonding curves Pump.fun).  
**Problème racine du WR ~10% :** le pipeline d'entrée ne fait qu'une analyse légère (Guard.validateCurveForExecution) alors que le sniper faisait une analyse complète (honeypot, top holders, liquidité, historique créateur, social). Les curve HOT entrent sans ces vérifications → mauvaise sélection → pertes.

**Décision stratégique :**
1. Supprimer tout le code sniper (MarketScanner, sniper routes dans DecisionCore, Guard.analyzeToken pour Raydium)
2. Migrer TOUTE la logique d'analyse approfondie du sniper vers le pipeline curve
3. Créer un `CurveTokenAnalyzer` — module d'analyse complète async, cachée, non-bloquante
4. Corriger tous les bugs trouvés dans l'audit (confidence 0 trade, stall hasMicro, hard time stop, double-label, évictions COLD)
5. Aligner AGENTS.md sur la réalité du repo

**Référence obligatoire :** `APEX_QUANT_STRATEGY.md` — sections 5 (vétos + scoring), 6 (condition d'entrée), 8 (sorties)

---

## PROMPT CURSOR 1 — SUPPRESSION DU SNIPER + NETTOYAGE ARCHITECTURE

```
@codebase
@file src/app.ts
@file src/engine/DecisionCore.ts
@file src/ingestors/MarketScanner.ts
@file src/detectors/Guard.ts
@file src/types/index.ts

═══ OBJECTIF ═══

Supprimer entièrement la stratégie "sniper" (Raydium) pour concentrer 100% des
ressources sur la stratégie "curve-prediction" (Pump.fun bonding curves).
La stratégie sniper ne sera plus jamais utilisée.

═══ TÂCHE 1 : Supprimer MarketScanner.ts ═══

Dans src/app.ts :
  - Retirer tous les imports liés à MarketScanner
  - Retirer l'instanciation et le démarrage de MarketScanner
  - Retirer le handler d'événements 'newToken' de MarketScanner
  - Garder UNIQUEMENT PumpScanner, CurveTracker, TieredMonitor, BatchPoller

Ne pas supprimer le fichier MarketScanner.ts (garder comme archive), mais commenter
une ligne en haut : // DEPRECATED — sniper strategy removed 2026-03-24

═══ TÂCHE 2 : Nettoyer DecisionCore.ts ═══

Dans src/engine/DecisionCore.ts :
  - Retirer la méthode processMarketEvent() et tout son contenu
  - Retirer les imports liés au sniper (Jupiter executor, sniper types si séparés)
  - Retirer les références à STRATEGY_MODE === 'sniper' ou STRATEGY_MODE === 'market'
  - Garder UNIQUEMENT processCurveEvent() et les méthodes associées curve
  - Dans le constructeur, si STRATEGY_MODE !== 'curve-prediction', throw une erreur claire :
    throw new Error('STRATEGY_MODE must be "curve-prediction". Sniper strategy has been removed.');

═══ TÂCHE 3 : Nettoyer Guard.ts ═══

Dans src/detectors/Guard.ts :
  - Garder validateCurveForExecution() et validateCurve() — ce sont les méthodes curve
  - Marquer analyzeToken() (Raydium/DEX analysis) comme DEPRECATED avec un commentaire
  - Ne pas supprimer analyzeToken() car on va réutiliser sa logique dans CurveTokenAnalyzer (Prompt 2)

═══ TÂCHE 4 : Mettre à jour src/types/index.ts ═══

S'assurer que STRATEGY_MODE est un type littéral :
  type StrategyMode = 'curve-prediction'   // unique mode supporté

Supprimer les types exclusivement liés au sniper (SniperConfig, MarketEvent si non réutilisé, etc.)
Garder tous les types curve (TrackedCurve, BondingCurveState, CurvePosition, etc.)

═══ TÂCHE 5 : Mettre à jour .env.example ═══

Commenter ou supprimer les variables sniper-only :
  # STRATEGY_MODE=sniper  ← supprimer
  STRATEGY_MODE=curve-prediction  ← seule valeur valide

═══ RÈGLES ═══
- Bun strict TypeScript — 0 erreur typecheck
- Pas de any
- Loguer : "🧹 [Architecture] Sniper strategy removed — curve-prediction only"
```

---

## PROMPT CURSOR 2 — CurveTokenAnalyzer : L'ANALYSE COMPLÈTE DU TOKEN

```
@codebase
@file src/detectors/Guard.ts                              (référence — analyzeToken existant)
@file src/modules/graduation-predictor/HolderDistribution.ts  (référence — top holders)
@file src/modules/graduation-predictor/BotDetector.ts         (référence — bot detection)
@file src/modules/graduation-predictor/WalletScorer.ts        (référence — wallet analysis)
@file src/modules/graduation-predictor/VelocityAnalyzer.ts    (référence — VelocitySignal)
@file src/modules/curve-tracker/CurveTracker.ts               (référence — TrackedCurve)
@file src/types/bonding-curve.ts
@file APEX_QUANT_STRATEGY.md
@file src/infra/fetchWithTimeout.ts

═══ OBJECTIF ═══

Créer src/detectors/CurveTokenAnalyzer.ts — module d'analyse COMPLÈTE d'un token
sur bonding curve, équivalent à ce que le sniper faisait sur Raydium, mais adapté
au contexte bonding curve et non-bloquant (résultat caché, TTL 5 minutes).

C'est LA pièce manquante qui explique le WR ~10%. On entre sur des tokens sans
avoir vérifié les holders, la sécurité, l'historique créateur, ou le social.

═══ INTERFACE FullCurveAnalysis ═══

interface FullCurveAnalysis {
  mint: string
  analyzedAt: number
  latencyMs: number

  // ── Sécurité (VETOS absolus si red flag) ──
  security: {
    isHoneypot: boolean               // simulation de sell échoue
    creatorIsSelling: boolean         // créateur vend pendant la curve (VETO V1)
    creatorTokenCount: number         // nb de tokens lancés par ce créateur (> 5 = red flag)
    creatorWinRate: number            // % de tokens du créateur qui ont gradué
    mintAuthorityRevoked: boolean     // renonce au mint authority (bon signe)
    freezeAuthorityRevoked: boolean   // renonce au freeze authority (bon signe)
  }

  // ── Distribution holders ──
  holders: {
    top10Concentration: number        // % de supply dans les 10 plus gros wallets
    freshWalletRatio: number          // ratio wallets < 7 jours d'ancienneté
    sniperCount: number               // wallets qui ont acheté dans le premier block
    smartMoneyCount: number           // wallets dans notre WhaleWalletDB
    devHolding: number                // % que le développeur conserve encore
    holderCount: number               // nb total de wallets distincts
    holderQualityScore: number        // 0→1 composé (bas = bad distribution)
  }

  // ── Liquidité & microstructure ──
  liquidity: {
    realSolInCurve: number            // SOL réels dans la bonding curve
    tradingIntensity: number          // avgSolPerTrade = realSol / tradeCount
    botTransactionRatio: number       // ratio transactions bot détectées
    progressRegressing: boolean       // le progress a baissé de > 5% dans les 3 derniers polls
    velocityAcceleration: number      // positif = momentum croissant
    uniqueWallets: number             // wallets distincts ayant tradé
  }

  // ── Social ──
  social: {
    hasTelegram: boolean
    telegramMemberCount: number
    telegramRedFlags: number
    grokHypeScore: number             // 0→10, 0 si pas de clé xAI
    dexScreenerBoosted: boolean
    compositeScore: number            // 0→1
  }

  // ── Verdict final ──
  verdict: {
    passed: boolean
    vetoFired: string | null          // raison du veto si rejeté
    analysisScore: number             // 0→1 (combine tous les signaux)
    confidence: number                // 0→1 (combien de données disponibles)
    recommendedAction: 'ENTER' | 'SKIP' | 'WATCH'
  }
}

═══ CLASSE CurveTokenAnalyzer ═══

Fichier : src/detectors/CurveTokenAnalyzer.ts

class CurveTokenAnalyzer {
  private cache: Map<string, { analysis: FullCurveAnalysis; expiresAt: number }>
  private readonly CACHE_TTL_MS = 5 * 60 * 1_000  // 5 minutes
  private inflightAnalyses: Map<string, Promise<FullCurveAnalysis>>

  // Singleton
  private static instance: CurveTokenAnalyzer
  static getInstance(): CurveTokenAnalyzer

  async analyze(
    curve: TrackedCurve,
    velocity: VelocitySignal,
  ): Promise<FullCurveAnalysis>
    // 1. Vérifier cache — si présent et non expiré, retourner immédiatement
    // 2. Dédupliquer les appels concurrents (inflightAnalyses)
    // 3. Lancer l'analyse complète en parallèle (Promise.allSettled)
    // 4. Cacher le résultat
    // 5. Logger latence totale

  private async analyzeSecurityLayer(curve: TrackedCurve): Promise<security>
    // Appeler Guard.analyzeToken() adapté pour la bonding curve
    // Vérifier creator history via Helius getSignaturesForAddress(creator)
    // Compter combien de tokens le créateur a lancé (lookback 30 jours)
    // Vérifier si mint/freeze authority revoqués (getParsedAccountInfo)
    // Timeout global 3s — si dépasse → résultat partiel (ne pas bloquer)

  private async analyzeHoldersLayer(curve: TrackedCurve): Promise<holders>
    // Appeler HolderDistribution si disponible (optionnel, timeout 3s)
    // Analyser les wallets des transactions récentes (BotDetector + WalletScorer)
    // Calculer holderQualityScore :
    //   score = (1 - top10Concentration / 100) * 0.4
    //         + (1 - freshWalletRatio) * 0.3
    //         + (1 - min(sniperCount / 20, 1)) * 0.3
    // Si pas de données → holderQualityScore = 0.5 (neutre)

  private async analyzeLiquidityLayer(
    curve: TrackedCurve,
    velocity: VelocitySignal,
  ): Promise<liquidity>
    // Données principalement disponibles via curve et velocity (pas de RPC additionnel)
    // tradingIntensity = curve.realSolInCurve / curve.tradeCount
    // progressRegressing : comparer progress actuel vs progress il y a 3 polls
    //   (stocker dans un rolling buffer interne par mint)
    // Calcul uniquement à partir des données existantes → latence 0ms

  private async analyzeSocialLayer(curve: TrackedCurve): Promise<social>
    // 1. DexScreener : GET https://api.dexscreener.com/latest/dex/tokens/{mint}
    //    Timeout 2s, try/catch silencieux
    //    Parser: pairs[0]?.info?.socials pour trouver telegram
    //    Parser: pairs[0]?.boosts pour dexScreenerBoosted
    // 2. Si clé XAI_API_KEY disponible → GrokXScanner.analyzeToken()
    //    Sinon grokHypeScore = 0
    // 3. Si TelegramPulse disponible ET telegram trouvé → lire 50 derniers msgs
    //    Chercher red flags: ['rug', 'scam', 'dump', 'sell now', 'exit']
    //    Sinon skip silencieusement
    // 4. compositeScore = grokHypeScore/10 * 0.5 + telegramScore * 0.3 + dexBoost * 0.2

  private computeVerdictLayer(
    security: security,
    holders: holders,
    liquidity: liquidity,
    social: social,
    curve: TrackedCurve,
    velocity: VelocitySignal,
  ): verdict

    // ═══ VÉTOS ABSOLUS (si l'un fire → SKIP immédiat) ═══

    // V1 : Créateur en train de vendre (rug pull imminent)
    if (security.creatorIsSelling) → veto 'creator_selling'

    // V2 : Honeypot détecté
    if (security.isHoneypot) → veto 'honeypot'

    // V3 : Ratio bot trop élevé (manipulation pure)
    if (liquidity.botTransactionRatio > parseFloat(process.env.VETO_BOT_RATIO ?? '0.70'))
      → veto 'bot_manipulation'

    // V4 : Progress en régression (les gens vendent massivement)
    if (liquidity.progressRegressing && curve.progress < 0.60)
      → veto 'progress_regressing'

    // V5 : Créateur série-rug (trop de tokens lancés avec mauvais track record)
    if (security.creatorTokenCount > 10 && security.creatorWinRate < 0.05)
      → veto 'serial_rugger'

    // V6 : Top 10 holders trop concentrés (whale dump risk)
    if (holders.top10Concentration > parseFloat(process.env.VETO_MAX_TOP10_PCT ?? '80'))
      → veto 'whale_concentration'

    // V7 : Trading intensity trop faible (pas d'engagement réel)
    const minIntensity = parseFloat(process.env.VETO_MIN_INTENSITY ?? '0.15')
    if (liquidity.tradingIntensity < minIntensity)
      → veto 'low_intensity'

    // V8 : Token trop vieux sans momentum suffisant
    const ageMin = (Date.now() - (curve.createdAt ?? Date.now())) / 60_000
    const minProgress = parseFloat(process.env.VETO_MIN_FRESH_PROGRESS ?? '0.60')
    if (ageMin > 45 && curve.progress < minProgress)
      → veto 'stale_momentum'

    // V9 : Red flags sociaux critiques
    if (social.telegramRedFlags >= 3)
      → veto 'social_red_flags'

    // V10 : Développeur conserve trop (prêt à dump)
    if (holders.devHolding > parseFloat(process.env.VETO_MAX_DEV_HOLDING ?? '15'))
      → veto 'dev_holding_too_high'

    // ═══ SCORE COMPOSITE (si tous vétos clear) ═══

    // Pondérations alignées avec APEX_QUANT_STRATEGY.md §5
    const w = {
      tradingIntensity: 0.35,    // Variable #1 du papier Marino
      velocityMomentum: 0.20,    // Accélération = conviction
      antiBotScore:     0.15,    // Bot activity ↑ → graduation ↓
      holderQuality:    0.10,    // Distribution saine
      smartMoney:       0.08,    // Baleines ont acheté
      socialSignal:     0.07,    // Attention externe
      progressSigmoid:  0.05,    // Prior bayésien sur l'avancement
    }

    const intensityNorm = Math.min(1, liquidity.tradingIntensity / 1.0)
    const velocityNorm  = Math.min(1, velocity.solPerMinute_1m / 3.0)
    const antiBotNorm   = 1 - liquidity.botTransactionRatio
    const holderNorm    = holders.holderQualityScore
    const smartMoneyNorm = Math.min(1, holders.smartMoneyCount / 3)
    const socialNorm    = social.compositeScore
    const progressNorm  = 1 / (1 + Math.exp(-12 * (curve.progress - 0.55)))

    const analysisScore =
      w.tradingIntensity * intensityNorm +
      w.velocityMomentum * velocityNorm  +
      w.antiBotScore     * antiBotNorm   +
      w.holderQuality    * holderNorm    +
      w.smartMoney       * smartMoneyNorm +
      w.socialSignal     * socialNorm    +
      w.progressSigmoid  * progressNorm

    // Confidence : combien de couches ont fourni des données réelles
    const confidence = [
      security.mintAuthorityRevoked !== undefined ? 0.20 : 0.05,  // sécurité dispo
      holders.holderCount > 0 ? 0.20 : 0.05,                     // holders dispo
      velocity.tradesToReachCurrentLevel > 5 ? 0.25 : 0.10,      // velocity riche
      social.hasTelegram ? 0.15 : 0.05,                           // social dispo
      holders.smartMoneyCount >= 0 ? 0.20 : 0.05,                 // whale data
    ].reduce((a, b) => a + b, 0)

    return {
      passed: true,  // tous vétos clear
      vetoFired: null,
      analysisScore,
      confidence,
      recommendedAction: analysisScore > 0.50 ? 'ENTER' :
                         analysisScore > 0.35 ? 'WATCH' : 'SKIP',
    }
}

═══ EXPORT ═══

export function getCurveTokenAnalyzer(): CurveTokenAnalyzer {
  return CurveTokenAnalyzer.getInstance();
}

═══ RÈGLES D'IMPLÉMENTATION ═══
- Promise.allSettled() pour tous les layers (jamais Promise.all — un échec ne tue pas tout)
- Timeout global de 8s sur l'analyse complète — après ça, retourner résultat partiel
- JAMAIS bloquer la boucle principale : l'analyse tourne en arrière-plan
- Le cache déduplique les appels concurrents (inflightAnalyses Map)
- try/catch silencieux sur CHAQUE layer — un layer qui échoue = données partielles
- Logger format : "🔬 [CurveAnalyzer] {mint.slice(0,8)} | {latency}ms | score={score.toFixed(3)} | {verdict}"
- 0 any, typage strict
- Exporter l'interface FullCurveAnalysis dans src/types/index.ts
```

---

## PROMPT CURSOR 3 — INTÉGRATION CurveTokenAnalyzer DANS DecisionCore

```
@codebase
@file src/engine/DecisionCore.ts                          (MODIFICATION)
@file src/detectors/CurveTokenAnalyzer.ts                 (créé au prompt 2)
@file src/modules/graduation-predictor/GraduationPredictor.ts  (MODIFICATION)
@file src/modules/graduation-predictor/BreakevenCurve.ts  (référence)
@file src/data/FeatureStore.ts                            (référence — snapshots)
@file APEX_QUANT_STRATEGY.md

═══ OBJECTIF ═══

Intégrer CurveTokenAnalyzer dans le pipeline processCurveEvent() de DecisionCore.
L'analyse complète doit être CACHÉE et non-bloquante — elle tourne en arrière-plan
dès qu'un token entre en HOT, pas au moment de la décision d'entrée.

═══ TÂCHE 1 : Pré-analyse en arrière-plan quand un token entre en HOT ═══

Dans DecisionCore, écouter l'événement 'tieredMonitor:promoted' ou équivalent.
Quand un token passe en tier HOT :
  → Lancer getCurveTokenAnalyzer().analyze(curve, velocity) en arrière-plan (pas d'await)
  → Stocker la Promise dans une Map<string, Promise<FullCurveAnalysis>> privée
  → Logger : "🔬 [DecisionCore] Pre-analysis launched for {mint.slice(0,8)}"

═══ TÂCHE 2 : Utiliser l'analyse dans processCurveEvent() ═══

Dans processCurveEvent(), AVANT de calculer pGrad :

  // 1. Récupérer l'analyse (si disponible en cache)
  const analyzer = getCurveTokenAnalyzer();
  const analysis = analyzer.getCached(curve.mint);  // retourne null si pas encore prête

  // 2. Si l'analyse est disponible ET verdict négatif → SKIP immédiat
  if (analysis !== null) {
    if (!analysis.verdict.passed) {
      console.log(`⛔ [DecisionCore] SKIP {mint} — veto: {analysis.verdict.vetoFired}`);
      return;  // ne pas traiter ce token
    }
    if (analysis.verdict.recommendedAction === 'SKIP') {
      console.log(`⚠️  [DecisionCore] SKIP {mint} — low score: {analysis.verdict.analysisScore.toFixed(3)}`);
      return;
    }
  }

  // 3. Si l'analyse n'est pas encore disponible → lancer et continuer avec garde légère
  if (analysis === null) {
    analyzer.analyze(curve, velocity).catch(() => {}); // lance en background
    // Continuer avec la garde légère existante (conservative)
  }

═══ TÂCHE 3 : Incorporer l'analysisScore dans le scoring GraduationPredictor ═══

Dans GraduationPredictor.predictFromCurveState() ou predict() :

  // Si une FullCurveAnalysis est disponible, l'utiliser pour booster/réduire pGrad
  if (analysis !== null && analysis.verdict.passed) {
    // Le analysisScore remplace les heuristiques partielles
    // La confidence de l'analyse module le safety margin
    const safetyMargin = 1 + (1 - analysis.verdict.confidence) * 0.8;
    // Formule APEX_QUANT_STRATEGY.md §6 :
    //   safety_margin(confidence) = 1 + (1 - confidence) × 0.8
    // Cela donne :
    //   confidence = 0.20 → margin 1.64× (très conservateur, peu de données)
    //   confidence = 0.50 → margin 1.40× (données partielles)
    //   confidence = 0.80 → margin 1.16× (bonnes données)
    //   confidence = 0.95 → margin 1.04× (excellent — futur modèle ML)
    result.requiredSafetyMargin = safetyMargin;

    // Enrichir le social score avec les données fraîches de l'analyse
    if (analysis.social.compositeScore > 0) {
      result.socialScore = analysis.social.compositeScore;
    }

    // Intégrer smartMoney depuis WhaleWalletDB
    if (analysis.holders.smartMoneyCount > 0) {
      result.smartMoneyScore = Math.min(1, analysis.holders.smartMoneyCount / 3);
    }

    // Intégrer holderQuality
    result.holderQualityScore = analysis.holders.holderQualityScore;
  }

═══ TÂCHE 4 : CORRIGER le bug confidence "0 trade" ═══

Dans GraduationPredictor.predictFromCurveState() :
  AVANT : const confidence = 0.35;  (ou 0.15 selon la version)
  APRÈS : const confidence = 0.20;  // conservative, peu de données disponibles

  RAISON : APEX_QUANT_STRATEGY.md §6 dit que confidence 0.20 → safety_margin 1.64×
  ce qui est approprié quand on n'a que l'heuristique sans analyse complète.
  Cette valeur est maintenant documentée et alignée entre AGENTS.md et le code.

  NOTE : Si FullCurveAnalysis est disponible, la confidence sera calculée
  dynamiquement (voir Tâche 3). Le 0.20 ne s'applique qu'au fallback heuristic pur.

═══ TÂCHE 5 : Logger le pipeline complet pour débug ═══

Dans processCurveEvent(), à chaque évaluation pour un token HOT :
  → Logger un résumé sur UNE ligne :
    "📊 [DC] {mint.slice(0,8)} | prog={progress}% | pGrad={pGrad}% | be={breakeven}% | 
     score={analysisScore} | conf={confidence} | action={action} | {latency}ms"

  Objectif : pouvoir voir d'un coup d'oeil pourquoi un token est entré ou skippé.

═══ RÈGLES ═══
- Pas de await dans le chemin critique de processCurveEvent — analyse en background
- getCached() doit retourner null si expire ou pas encore prête (jamais throw)
- 0 erreur typecheck
```

---

## PROMPT CURSOR 4 — FIX BUGS CRITIQUES AUDIT (ExitEngine + TieredMonitor)

```
@codebase
@file src/modules/position/ExitEngine.ts                      (MODIFICATION)
@file src/modules/curve-tracker/TieredMonitor.ts              (MODIFICATION)
@file src/data/FeatureStore.ts                                (MODIFICATION)
@file CURSOR_DIRECTIVE_ROTATION_AGRESSIVE.md

═══ BUG FIX 1 : Stall detection cassée par la condition hasMicro ═══

PROBLÈME : Dans ExitEngine.evaluate(), le stall check est conditionné par `hasMicro`.
Si cette variable est false (souvent en early HOT quand les données de microstructure
ne sont pas encore alimentées), le stall ne fire JAMAIS.
Les positions stagnent indéfiniment, bloquant les 5 slots.

CORRECTION dans evaluate() :

  // AVANT (cassé) :
  const hasMicro = velocity.tradesToReachCurrentLevel > 0 || velocity.peakVelocity_5m > 1e-6;
  if (hasMicro && velocity.velocityRatio < this.stallVelocityThreshold && velocity.solPerMinute_1m < this.stallSolFlowMin) {
    ...
  }

  // APRÈS (correct) :
  // Le stall se base sur le flux SOL réel UNIQUEMENT — pas sur des métriques dérivées
  // qui peuvent être 0 si pas encore calculées.
  if (velocity.solPerMinute_1m < this.stallSolFlowMin) {
    // Compteur de time en stall (déjà présent dans stallLowSince Map)
    // Si stall depuis > STALL_DURATION_SECONDS → signal
  }

═══ BUG FIX 2 : Hard time stop contournable par livePGrad ═══

PROBLÈME : Le time stop actuel peut être bypassé par le live pGrad.
Le fallback heuristique retourne TOUJOURS pGrad > 0.5 pour les curves > 50% progress
→ le bypass s'active → le time stop ne fire jamais.

CORRECTION : Ajouter un HARD time stop ABSOLU après le time stop bypassable :

  // HARD TIME STOP — ne peut PAS être bypassé par pGrad
  const HARD_MAX_HOLD_MS = parseInt(process.env.HARD_MAX_HOLD_SECONDS ?? '300') * 1000;
  const holdMs = Date.now() - position.entryTimestamp;
  
  if (holdMs > HARD_MAX_HOLD_MS) {
    this.stallLowSince.delete(position.mint);
    console.log(`⏰ [ExitEngine] HARD TIME STOP: {mint} held {holdMs/1000}s — NO bypass`);
    return {
      mint: position.mint,
      reason: 'time_stop',
      action: 'SELL_100PCT',
      urgency: 'CRITICAL',
      detail: `Hard time stop: ${holdMs / 1000}s > ${HARD_MAX_HOLD_MS / 1000}s (absolute max)`,
      positionPnlPct: position.unrealizedPnlPct,
    };
  }

  // Variable d'env à ajouter dans .env.example :
  # Hard time stop absolu (secondes) — ne peut pas être bypassé
  HARD_MAX_HOLD_SECONDS=300

═══ BUG FIX 3 : Régression du progress non détectée ═══

PROBLÈME : Quand le progress BAISSE (les gens vendent), aucun code ne détecte ça.
Un token à 55% qui tombe à 24% est un token qui meurt — on doit couper.

CORRECTION dans evaluate() :

  // Ajouter APRÈS le stop-loss check :
  
  // RÉGRESSION PROGRESS — momentum inversé (vendeurs dominent)
  const progressDropThreshold = parseFloat(process.env.PROGRESS_DROP_VETO ?? '0.08'); // 8 points
  if (
    position.entryProgress !== undefined &&
    curve.progress < position.entryProgress - progressDropThreshold &&
    position.unrealizedPnlPct < -0.05
  ) {
    console.log(`📉 [ExitEngine] Progress regression: {position.entryProgress * 100}% → {curve.progress * 100}%`);
    return {
      reason: 'progress_regression',
      action: 'SELL_100PCT',
      urgency: 'HIGH',
      ...
    };
  }

  # Variable d'env :
  PROGRESS_DROP_VETO=0.08

═══ BUG FIX 4 : Évictions COLD/WARM trop lentes → 0 outcomes ═══

PROBLÈME : Les evictions n'arrivent qu'après 24h. En 2h de run, 0 outcomes.
Sans outcomes → pas de dataset ML → pas d'entraînement.

CORRECTION dans TieredMonitor.demoteOrEvict() :

  // Ajouter ces règles AVANT les règles existantes (plus agressives) :

  const nowMs = Date.now();

  // HOT stagnant > 30 min sans progress significatif → evict
  if (curve.tier === 'hot') {
    const ageMin = (nowMs - curve.createdAt) / 60_000;
    const sinceUpdate = (nowMs - curve.lastUpdated) / 60_000;
    if (ageMin > 30 && sinceUpdate > 5) {
      this.evict(mint, 'hot_stalled_30min');
      return;
    }
    // HOT > 60min dans tous les cas
    if (ageMin > 60) {
      this.evict(mint, 'hot_timeout_60min');
      return;
    }
  }

  // WARM > 2h sans atteindre HOT
  if (curve.tier === 'warm') {
    const ageMin = (nowMs - curve.createdAt) / 60_000;
    if (ageMin > 120) {
      this.evict(mint, 'warm_timeout_2h');
      return;
    }
    // WARM > 30min ET progress a régressé sous 20%
    if (ageMin > 30 && curve.progress < 0.20) {
      this.evict(mint, 'warm_regressed');
      return;
    }
  }

  // COLD > 2h (au lieu de 24h) et progress < 15%
  if (curve.tier === 'cold') {
    const ageMin = (nowMs - curve.createdAt) / 60_000;
    if (ageMin > 120 && curve.progress < 0.15) {
      this.evict(mint, 'cold_stale_2h');
      return;
    }
  }

  // Toute curve progress < 5% depuis > 10 min → mort
  if (curve.progress < 0.05 && (nowMs - curve.createdAt) > 600_000) {
    this.evict(mint, 'progress_collapsed');
    return;
  }

═══ BUG FIX 5 : Double-label bug (evicted + graduated) ═══

PROBLÈME dans FeatureStore.labelCurveOutcome() :
Si un token est évicté avec reason 'graduated', il peut être labellisé deux fois
(une fois par l'eviction, une fois par le graduation handler).

CORRECTION : Vérifier si un outcome existe déjà avant d'insérer :

  labelCurveOutcome(mint: string, graduated: boolean, reason: string): void {
    // Vérifier d'abord
    const existing = this.db.query(
      'SELECT id FROM curve_outcomes WHERE mint = ?'
    ).get(mint);
    
    if (existing) {
      console.log(`⚠️  [FeatureStore] Double-label prevented for {mint.slice(0,8)}`);
      return;  // Ne pas labelliser deux fois
    }
    
    // Sinon, insérer normalement
    this.db.query(
      'INSERT INTO curve_outcomes (mint, graduated, reason, labeled_at) VALUES (?, ?, ?, ?)'
    ).run(mint, graduated ? 1 : 0, reason, Date.now());
  }

═══ RÈGLES ═══
- Bun typecheck 0 erreur
- Logger clairement chaque fix avec le nom du bug corrigé
- Ajouter les nouvelles variables dans .env.example avec commentaires
```

---

## PROMPT CURSOR 5 — GraduationPredictor : DURCIR LA SÉLECTIVITÉ

```
@codebase
@file src/modules/graduation-predictor/GraduationPredictor.ts  (MODIFICATION MAJEURE)
@file src/modules/graduation-predictor/BreakevenCurve.ts       (référence)
@file src/detectors/CurveTokenAnalyzer.ts                      (créé au prompt 2)
@file APEX_QUANT_STRATEGY.md                                   (sections 5 et 6)

═══ OBJECTIF ═══

Le predictor entre sur trop de tokens (taux d'entrée ~40-100%).
Il doit n'entrer que sur les ~5-10% les plus forts.
C'est la correction directe du WR ~10%.

Section APEX_QUANT_STRATEGY.md §6 :
"En sélectionnant uniquement les tokens avec pGrad > breakeven × 1.5 :
  - On élimine ~85% des tokens HOT
  - Le win rate attendu passe de ~15% à ~45-60%"

═══ VÉTOS À IMPLÉMENTER (si pas déjà présents — vérifier dans le code) ═══

Dans predict() ou l'équivalent de la décision d'entrée :

// ═══ ÉTAGE 1 : VÉTOS ABSOLUS < 0.1ms ═══

// V1 : Créateur vend
if (curve.creatorIsSelling === true)
  return veto('creator_selling')

// V2 : Bot ratio trop élevé
const vetoBot = parseFloat(process.env.VETO_BOT_RATIO ?? '0.70')
if (botRatio > vetoBot)
  return veto('bot_dominated')

// V3 : Intensité trading insuffisante (variable #1 du papier Marino)
const minIntensity = parseFloat(process.env.VETO_MIN_INTENSITY ?? '0.15')
if (tradingIntensity < minIntensity)
  return veto('low_trading_intensity')

// V4 : Hors du sweet spot progress (35-55 SOL ≈ 45-85%)
const minProg = parseFloat(process.env.CURVE_ENTRY_MIN_PROGRESS ?? '0.45')
const maxProg = parseFloat(process.env.CURVE_ENTRY_MAX_PROGRESS ?? '0.85')
if (curve.progress < minProg || curve.progress > maxProg)
  return veto('outside_sweet_spot')

// V5 : Token trop vieux sans momentum suffisant
const ageMin = (Date.now() - (curve.createdAt ?? Date.now())) / 60_000
const minFreshProg = parseFloat(process.env.VETO_MIN_FRESH_PROGRESS ?? '0.60')
if (ageMin > 45 && curve.progress < minFreshProg)
  return veto('stale_momentum')

// V6 : Pas assez de trades (microstructure insuffisante pour calculer l'intensité)
const minTrades = parseInt(process.env.MIN_TRADE_COUNT ?? '10')
if ((curve.tradeCount ?? 0) < minTrades)
  return veto('insufficient_trades')

// V7 : Token trop récemment promu en HOT (pas assez de données)
const minMinutesHot = parseFloat(process.env.MIN_MINUTES_IN_HOT ?? '2.0')
const minutesInHot = curve.promotedToHotAt
  ? (Date.now() - curve.promotedToHotAt) / 60_000
  : 0
if (minutesInHot < minMinutesHot)
  return veto('too_early_in_hot')

// ═══ ÉTAGE 2 : SCORING + BREAKEVEN ═══

// Calculer pGrad (somme pondérée des 7 signaux)
// Les poids APEX_QUANT_STRATEGY.md §5 :
const WEIGHTS = {
  tradingIntensity: 0.35,
  velocityMomentum: 0.20,
  antiBotScore:     0.15,
  holderQuality:    0.10,
  smartMoney:       0.08,
  socialSignal:     0.07,
  progressSigmoid:  0.05,
}

// Si FullCurveAnalysis disponible → enrichir les scores
// Sinon → utiliser les heuristiques existantes

const pGrad = WEIGHTS.tradingIntensity * intensityNorm
            + WEIGHTS.velocityMomentum * velocityNorm
            + WEIGHTS.antiBotScore     * antiBotNorm
            + WEIGHTS.holderQuality    * holderNorm
            + WEIGHTS.smartMoney       * smartMoneyNorm
            + WEIGHTS.socialSignal     * socialNorm
            + WEIGHTS.progressSigmoid  * progressNorm

// Calculer le breakeven (APEX §3)
const breakeven = calcBreakevenWithFees(curve.progress)

// Calculer le safety margin dynamique (APEX §6)
// confidence dépend de la disponibilité de la FullCurveAnalysis :
const confidence = analysis?.verdict.confidence ?? 0.20
const safetyMargin = 1 + (1 - confidence) * 0.8
// confidence 0.20 → margin 1.64× (heuristique seule)
// confidence 0.80 → margin 1.16× (analyse complète dispo)

const requiredPGrad = breakeven * safetyMargin

// CONDITION D'ENTRÉE FORMELLE (APEX §6) :
if (pGrad <= requiredPGrad) {
  console.log(`📊 [Predictor] SKIP {mint} | pGrad={pGrad.toFixed(3)} ≤ required={requiredPGrad.toFixed(3)} (breakeven={breakeven.toFixed(3)} × {safetyMargin.toFixed(2)}×)`)
  return skip('below_breakeven_threshold')
}

// Kelly fraction check (APEX §7)
const b = calcMultipleAtGraduation(curve.progress) - 1  // multiple net
const fStar = (b * pGrad - (1 - pGrad)) / b
const kellyFraction = parseFloat(process.env.KELLY_FRACTION ?? '0.25')
const fAdjusted = fStar * kellyFraction

const minKelly = parseFloat(process.env.MIN_KELLY_FRACTION ?? '0.01')
if (fAdjusted < minKelly) {
  console.log(`📊 [Predictor] SKIP {mint} | Kelly f*={fStar.toFixed(3)} → adj={fAdjusted.toFixed(3)} < min={minKelly}`)
  return skip('kelly_too_small')  // edge insuffisant
}

// ENTER — tous les filtres sont passés
return {
  action: 'ENTER',
  pGrad,
  breakeven,
  safetyMargin,
  confidence,
  kellyStar: fStar,
  kellyAdjusted: fAdjusted,
  positionSOL: calcPositionSize(fAdjusted, bankroll),
}

═══ LOGGING DES VÉTOS (pour le dashboard et l'amélioration continue) ═══

Ajouter dans la classe un compteur de vétos par raison :
  private vetoStats: Map<string, number> = new Map()
  
  private veto(reason: string): VetoResult {
    const count = (this.vetoStats.get(reason) ?? 0) + 1
    this.vetoStats.set(reason, count)
    return { action: 'SKIP', vetoReason: reason }
  }

  getVetoStats(): Record<string, number> {
    return Object.fromEntries(this.vetoStats)
  }

  // Logger les stats toutes les 30min dans app.ts :
  // "📊 [VetoStats] bot_dominated=45 low_intensity=32 outside_sweet_spot=21..."

═══ VARIABLES D'ENVIRONNEMENT ═══

CURVE_ENTRY_MIN_PROGRESS=0.45
CURVE_ENTRY_MAX_PROGRESS=0.85
VETO_BOT_RATIO=0.70
VETO_MIN_INTENSITY=0.15
VETO_MAX_AGE_MINUTES=45
VETO_MIN_FRESH_PROGRESS=0.60
VETO_MAX_TOP10_PCT=80
VETO_MAX_DEV_HOLDING=15
MIN_TRADE_COUNT=10
MIN_MINUTES_IN_HOT=2.0
KELLY_FRACTION=0.25
MIN_KELLY_FRACTION=0.01
SAFETY_MARGIN_BASE=1.50

═══ RÈGLES ═══
- 0 erreur typecheck
- Chaque véto loggé avec émoji et raison claire
- Les vétos ne doivent pas throw, ils doivent return proprement
- Logger le taux de sélection toutes les 30min : X entrées sur Y évaluations = Z%
```

---

## PROMPT CURSOR 6 — PortfolioGuard CENTRALISÉ + Position Sizing Kelly

```
@codebase
@file src/modules/position/PositionManager.ts              (référence)
@file src/modules/position/ExitEngine.ts                   (référence)
@file src/engine/DecisionCore.ts                           (MODIFICATION)
@file APEX_QUANT_STRATEGY.md                               (sections 7 + 9)

═══ OBJECTIF ═══

Créer src/modules/risk/PortfolioGuard.ts — module centralisé de gestion du risque
portefeuille. Les caps positionnels sont actuellement éparpillés dans les variables
d'env et vérifiés à des endroits inconsistants.

═══ CLASSE PortfolioGuard ═══

Fichier : src/modules/risk/PortfolioGuard.ts

class PortfolioGuard {
  private readonly MAX_CONCURRENT_POSITIONS: number   // env: MAX_CONCURRENT_POSITIONS=5
  private readonly MAX_TOTAL_EXPOSURE_PCT: number     // env: MAX_TOTAL_EXPOSURE_PCT=0.25 (25% du bankroll)
  private readonly DAILY_LOSS_HALT_PCT: number        // env: DAILY_LOSS_HALT_PCT=0.15 (stop si -15%/jour)
  private readonly MAX_POSITION_SOL: number           // env: MAX_POSITION_SOL=0.50
  private readonly MIN_POSITION_SOL: number           // env: MIN_POSITION_SOL=0.03

  private dailyStartBankroll: number
  private dailyLossAccumulated: number
  private dailyTradeCount: number
  private haltedUntil: number | null  // timestamp de fin du halt

  // Appelé AVANT chaque buy — retourne si on peut trader
  canEnter(
    positionManager: PositionManager,
    proposedSolAmount: number,
    bankroll: number,
  ): { allowed: boolean; reason: string | null; adjustedAmount: number }

    // Check 1 : Halt journalier
    if (this.haltedUntil && Date.now() < this.haltedUntil)
      return { allowed: false, reason: 'daily_loss_halt' }

    // Check 2 : Nombre max de positions simultanées
    if (positionManager.getOpenCount() >= this.MAX_CONCURRENT_POSITIONS)
      return { allowed: false, reason: 'max_positions_reached' }

    // Check 3 : Exposition totale max
    const totalInvested = positionManager.getPortfolioSummary().totalInvested
    if ((totalInvested + proposedSolAmount) > bankroll * this.MAX_TOTAL_EXPOSURE_PCT)
      return { allowed: false, reason: 'max_exposure_reached' }

    // Check 4 : Perte journalière max → halt
    const dailyPnl = bankroll - this.dailyStartBankroll
    if (dailyPnl < 0 && Math.abs(dailyPnl) / this.dailyStartBankroll > this.DAILY_LOSS_HALT_PCT) {
      this.haltedUntil = Date.now() + 3_600_000  // halt 1h
      console.error('🛑 [PortfolioGuard] DAILY LOSS HALT activated — trading paused 1h')
      return { allowed: false, reason: 'daily_loss_halt_triggered' }
    }

    // Ajuster le montant proposé aux caps
    const adjustedAmount = Math.min(
      Math.max(proposedSolAmount, this.MIN_POSITION_SOL),
      this.MAX_POSITION_SOL,
    )

    return { allowed: true, reason: null, adjustedAmount }

  // Calculer la taille de position via Kelly (APEX §7)
  calcPositionSize(
    kellyFraction: number,  // f* ajusté (après multiplication par KELLY_FRACTION)
    bankroll: number,
  ): number
    const raw = kellyFraction * bankroll
    return Math.min(
      Math.max(raw, this.MIN_POSITION_SOL),
      this.MAX_POSITION_SOL,
      bankroll * parseFloat(process.env.MAX_POSITION_PCT ?? '0.10'),
    )

  // Reset journalier à minuit UTC
  resetDailyStats(currentBankroll: number): void

  // Logger les métriques toutes les 30min
  logStats(positionManager: PositionManager, bankroll: number): void
    console.log('📊 [PortfolioGuard] Positions: {open}/{max} | Exposure: {pct}% | Daily: {pnl} SOL | Halt: {haltedUntil ?? "none"}')
}

export const getPortfolioGuard = () => PortfolioGuard.getInstance()

═══ INTÉGRATION dans DecisionCore ═══

Dans processCurveEvent(), AVANT l'exécution du buy :

  const guard = getPortfolioGuard()
  const { allowed, reason, adjustedAmount } = guard.canEnter(
    getPositionManager(),
    proposedSolAmount,
    currentBankroll,
  )
  
  if (!allowed) {
    console.log(`🛡️  [PortfolioGuard] BLOCKED — {reason}`)
    return
  }
  
  // Utiliser adjustedAmount pour le buy (pas proposedSolAmount)

═══ RÈGLES ═══
- Singleton via getInstance()
- Reset journalier via setInterval à minuit UTC dans app.ts
- 0 any, typage strict
- Logger avec émojis précis
```

---

## PROMPT CURSOR 7 — DASHBOARD TERMINAL COMPLET + LOGGING QUALITÉ

```
@codebase
@file src/app.ts                                           (MODIFICATION)
@file src/modules/position/PositionManager.ts              (référence — getPortfolioSummary)
@file src/modules/graduation-predictor/GraduationPredictor.ts  (référence — getVetoStats)
@file src/modules/risk/PortfolioGuard.ts                   (référence — logStats)
@file src/detectors/CurveTokenAnalyzer.ts                  (référence)
@file src/modules/curve-tracker/TieredMonitor.ts           (référence)

═══ OBJECTIF ═══

Créer un dashboard terminal qui s'affiche toutes les 5 minutes pour avoir
une vue complète de l'état du bot. C'est le moyen de comprendre rapidement
pourquoi le WR est ce qu'il est et où les opportunités sont perdues.

═══ AFFICHAGE TOUTES LES 5 MINUTES ═══

Dans app.ts, ajouter un setInterval(() => printDashboard(), 300_000) :

function printDashboard(): void {
  const pos = getPositionManager().getPortfolioSummary()
  const vetos = getGraduationPredictor().getVetoStats()
  const tiered = getTieredMonitor().getStats()  // { hot, warm, cold, evictedTotal }
  const bankroll = getCurrentBankroll()  // paper ou réel

  console.log(`
╔══════════════════════════════════════════════════════════╗
║  APEX-2026 DASHBOARD  ${new Date().toISOString()}
╠══════════════════════════════════════════════════════════╣
║  💰 BANKROLL    : ${bankroll.toFixed(4)} SOL
║  📊 POSITIONS   : ${pos.openCount} ouvertes | ${pos.totalRealizedPnl >= 0 ? '✅' : '❌'} PnL: ${pos.totalRealizedPnl.toFixed(4)} SOL
║  🏆 WIN RATE    : ${(pos.winRate * 100).toFixed(1)}% (${pos.openCount + Object.values(vetos).reduce((a,b) => a+b, 0)} évaluations)
║  ⏱️  AVG HOLD    : ${pos.avgHoldDurationS.toFixed(0)}s
╠══════════════════════════════════════════════════════════╣
║  🔭 TRACKING    : ${tiered.hot} HOT | ${tiered.warm} WARM | ${tiered.cold} COLD
╠══════════════════════════════════════════════════════════╣
║  ⛔ VÉTOS (top causes de SKIP) :
${Object.entries(vetos)
  .sort(([,a],[,b]) => b - a)
  .slice(0, 6)
  .map(([k, v]) => `║    ${k.padEnd(30)} : ${v}`)
  .join('\n')}
╠══════════════════════════════════════════════════════════╣
║  📈 POSITIONS OUVERTES :
${getPositionManager().getOpenPositions()
  .map(p => `║    ${p.mint.slice(0,8)} | ${(p.unrealizedPnlPct * 100).toFixed(1)}% | ${((Date.now() - p.entryTimestamp)/1000).toFixed(0)}s`)
  .join('\n') || '║    (aucune)'}
╚══════════════════════════════════════════════════════════╝
  `)
}

═══ LOG FORMAT UNIFIÉ pour chaque décision ═══

À chaque événement HOT évalué, logger SUR UNE SEULE LIGNE :
  🔍 [EVAL] {mint.slice(0,8)} | prog={progress}% | pGrad={pGrad}% | be={breakeven}% | score={score} | → {action} ({reason}) | {latency}ms

Exemples :
  🔍 [EVAL] 7xKp3mNa | prog=62% | pGrad=61% | be=40% | score=0.72 | → ENTER | 45ms
  🔍 [EVAL] 2mJt9xPQ | prog=48% | pGrad=22% | be=30% | score=0.38 | → SKIP (bot_dominated) | 2ms
  🔍 [EVAL] 9nBv7cWs | prog=71% | pGrad=55% | be=52% | score=0.61 | → SKIP (below_breakeven) | 3ms

═══ RÈGLES ═══
- Le dashboard ne doit JAMAIS crasher (try/catch global)
- Si une métrique est undefined → afficher "N/A" pas throw
- Logger toutes les 5 minutes + au SIGINT
```

---

## PROMPT CURSOR 8 — MISE À JOUR AGENTS.md (CORRECTION DOCS OBSOLÈTES)

```
@codebase
@file AGENTS.md                                            (MODIFICATION)

═══ OBJECTIF ═══

Corriger les 4 phrases obsolètes dans AGENTS.md qui donnent une fausse image
du projet. Ces incorrections créent de la confusion quand on lit le code.

═══ CORRECTIONS À APPLIQUER ═══

CORRECTION 1 — Trailing stop sur reliquat :
  TROUVER la phrase : "trailing 15% sur reliquat post-TP 50% encore ouvert" 
                    ET/OU "trailing non implémenté"
  REMPLACER par : "trailing stop sur reliquat IMPLÉMENTÉ — TRAILING_REMAINDER_PCT dans ExitEngine"

CORRECTION 2 — GrokXScanner / NarrativeRadar :
  TROUVER : "pas de GrokXScanner", "GrokXScanner absent", "NarrativeRadar manquant"
  REMPLACER par : "GrokXScanner IMPLÉMENTÉ (src/social/GrokXScanner.ts) — clé XAI_API_KEY requise"
               ET "NarrativeRadar IMPLÉMENTÉ (src/social/NarrativeRadar.ts) — câblé dans DecisionCore"

CORRECTION 3 — WebSocketPool :
  TROUVER : "WebSocketPool absent" ou "WebSocket reconnects"
  REMPLACER par : "WebSocketPool IMPLÉMENTÉ — src/infra/WebSocketPool.ts — branché dans PumpScanner"

CORRECTION 4 — Confidence heuristique "0 trade" :
  TROUVER : "confidence 0.35" dans la section heuristique
  REMPLACER par : "confidence 0.20 (code réel dans predictFromCurveState) — aligné APEX_QUANT_STRATEGY.md §6"
  RAISON : "safety_margin(0.20) = 1.64× — très conservateur quand seule l'heuristique est disponible.
            Cette valeur est intentionnelle (moins de faux positifs)."

CORRECTION 5 — Stratégie sniper :
  TROUVER toutes les références à la stratégie "sniper" ou "market"
  AJOUTER : "⚠️ SNIPER STRATEGY REMOVED (2026-03-24) — seul curve-prediction est supporté"

CORRECTION 6 — Ajouter section "Modules récemment ajoutés" :
  CurveTokenAnalyzer.ts  — analyse complète token (security + holders + liquidity + social)
  PortfolioGuard.ts      — gestion centralisée du risque portefeuille
  (Avec date 2026-03-24)

═══ RÈGLES ═══
- Ne pas réécrire tout AGENTS.md — faire des corrections chirurgicales
- Garder le format existant (headings, tableaux si présents)
- Ajouter une ligne "Dernière mise à jour : 2026-03-24" en haut
```

---

## PROMPT CURSOR 9 — VARIABLES D'ENVIRONNEMENT COMPLÈTES + VALIDATION AU DÉMARRAGE

```
@codebase
@file src/app.ts                                           (MODIFICATION)
@file .env.example                                        (CRÉATION/MISE À JOUR)

═══ OBJECTIF ═══

1. Créer un .env.example complet et commenté avec TOUTES les variables
2. Ajouter une validation des variables critiques au démarrage du bot (fail fast)

═══ VALIDATION AU DÉMARRAGE dans app.ts ═══

Ajouter en TOUT PREMIER dans la fonction main() ou au top-level :

function validateEnv(): void {
  const required = [
    'HELIUS_RPC_URL',
    'WALLET_PRIVATE_KEY',
  ]
  
  const missing = required.filter(k => !process.env[k])
  if (missing.length > 0) {
    console.error(`❌ [STARTUP] Variables d'env manquantes : ${missing.join(', ')}`)
    process.exit(1)
  }
  
  // Vérifier cohérence des paramètres quant
  const minProg = parseFloat(process.env.CURVE_ENTRY_MIN_PROGRESS ?? '0.45')
  const maxProg = parseFloat(process.env.CURVE_ENTRY_MAX_PROGRESS ?? '0.85')
  if (minProg >= maxProg) {
    console.error(`❌ [STARTUP] CURVE_ENTRY_MIN_PROGRESS (${minProg}) doit être < MAX (${maxProg})`)
    process.exit(1)
  }
  
  console.log('✅ [STARTUP] Environment variables validated')
  console.log(`📊 [CONFIG] Mode: curve-prediction | Entry: ${minProg*100}%-${maxProg*100}% progress`)
  console.log(`📊 [CONFIG] Stop-loss: -${parseFloat(process.env.STOP_LOSS_PCT ?? '0.15')*100}% | Trailing: -${parseFloat(process.env.TRAILING_STOP_PCT ?? '0.20')*100}% from peak`)
  console.log(`📊 [CONFIG] Max positions: ${process.env.MAX_CONCURRENT_POSITIONS ?? '5'} | Max exposure: ${process.env.MAX_TOTAL_EXPOSURE_PCT ?? '0.25'*100}%`)
}

═══ .env.example COMPLET ═══

# ═══════════════════════════════════════════════
# APEX-2026 — Variables d'environnement
# Dernière mise à jour : 2026-03-24
# ═══════════════════════════════════════════════

# ── Stratégie (NE PAS CHANGER) ──
STRATEGY_MODE=curve-prediction
TRADING_MODE=paper   # paper | live

# ── RPC (au moins HELIUS_RPC_URL requis) ──
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_API_KEY=YOUR_KEY
QUICKNODE_RPC_URL=https://...  # optionnel — pour le RPC racing
ALCHEMY_RPC_URL=https://...   # optionnel — fallback

# ── Wallet ──
WALLET_PRIVATE_KEY=BASE58_OR_JSON_ARRAY   # requis même en paper

# ── Paper trading ──
PAPER_BANKROLL_SOL=2.0

# ── Zone d'entrée (Sweet Spot APEX §4) ──
CURVE_ENTRY_MIN_PROGRESS=0.45    # 45% progress minimum (≈30 SOL)
CURVE_ENTRY_MAX_PROGRESS=0.85    # 85% progress maximum (≈70 SOL)
MIN_TRADE_COUNT=10               # minimum de trades pour avoir une microstructure
MIN_MINUTES_IN_HOT=2.0           # attendre que la curve soit HOT depuis 2 min

# ── Vétos (APEX §5 Étage 1) ──
VETO_BOT_RATIO=0.70              # skip si > 70% de transactions sont des bots
VETO_MIN_INTENSITY=0.15          # skip si < 0.15 SOL/trade en moyenne
VETO_MAX_AGE_MINUTES=45          # skip si le token a > 45 min et progress < seuil
VETO_MIN_FRESH_PROGRESS=0.60     # progress minimum requis pour un token > 45 min
VETO_MAX_TOP10_PCT=80            # skip si top 10 holders > 80% de la supply
VETO_MAX_DEV_HOLDING=15          # skip si dev conserve > 15% (dump risk)

# ── Kelly + Position sizing (APEX §7) ──
KELLY_FRACTION=0.25              # quarter-Kelly (conservateur)
MIN_KELLY_FRACTION=0.01          # skip si edge trop faible
MAX_POSITION_PCT=0.10            # max 10% du bankroll par trade
MIN_POSITION_SOL=0.03            # minimum absolu
MAX_POSITION_SOL=0.50            # maximum absolu
PAPER_MAX_POSITION_SOL=0.10      # max en paper trading

# ── Sorties (APEX §8) ──
STOP_LOSS_PCT=0.15               # cut à -15%
TRAILING_STOP_PCT=0.20           # trailing stop 20% depuis le peak
TAKE_PROFIT_PCT=0.50             # take profit 50% à +50%
TRAILING_REMAINDER_PCT=0.15      # trailing sur le reliquat après TP
TIME_STOP_SECONDS=600            # time stop à 10 minutes (soft, bypassable par pGrad)
HARD_MAX_HOLD_SECONDS=300        # HARD time stop à 5 minutes (NO bypass)
STALL_SOL_FLOW_MIN=0.05          # stall si < 0.05 SOL/min
STALL_DURATION_SECONDS=90        # pendant 90 secondes
PROGRESS_DROP_VETO=0.08          # exit si progress drop > 8 points

# ── Graduation exit 3 tranches (APEX §8) ──
GRAD_T1_PCT=0.40                 # 40% vendu immédiatement à graduation
GRAD_T2_PCT=0.35                 # 35% vendu après 60s sur PumpSwap
GRAD_T2_DELAY_MS=60000
GRAD_T3_PCT=0.25                 # 25% avec trailing 20% depuis peak post-grad
GRAD_T3_TRAILING_STOP=0.20
GRAD_T3_MAX_HOLD_MS=300000       # max 5 min pour T3

# ── Risk portefeuille ──
MAX_CONCURRENT_POSITIONS=5
MAX_TOTAL_EXPOSURE_PCT=0.25      # max 25% du bankroll en positions ouvertes
DAILY_LOSS_HALT_PCT=0.15         # halt 1h si -15% dans la journée

# ── Analyse token (CurveTokenAnalyzer) ──
CURVE_FULL_GUARD=1               # 1 = analyse complète (recommandé toujours)
ANALYZER_TIMEOUT_MS=8000         # timeout global de l'analyse complète

# ── Social ──
XAI_API_KEY=                     # optionnel — Grok X Search ($175/mois crédits gratuits)
GROQ_API_KEY=                    # optionnel — NLP Llama-3
TELEGRAM_API_ID=                 # optionnel — GramJS
TELEGRAM_API_HASH=               # optionnel
TELEGRAM_SESSION_STRING=         # optionnel

# ── Jito (anti-MEV, uniquement en LIVE) ──
JITO_BLOCK_ENGINE_URL=https://amsterdam.mainnet.block-engine.jito.wtf
JITO_TIP_LAMPORTS=50000

# ── ML (futur) ──
ONNX_GRADUATION_MODEL=models/graduation_v1.onnx
RETRAIN_INTERVAL_HOURS=6
MIN_AUCPR_THRESHOLD=0.15

# ── Whale Discovery ──
WHALE_MIN_WIN_RATE=0.30          # minimum 30% win rate pour être considéré whale
WHALE_MIN_TOKEN_COUNT=3          # minimum 3 tokens achetés pour avoir des stats
```

---

## ORDRE D'EXÉCUTION ET TESTS

```
SÉQUENCE D'IMPLÉMENTATION :
════════════════════════════

① Prompt 1 — Suppression sniper [30 min]
   → bun run typecheck → 0 erreur
   → Test : bun run start → bot démarre sans MarketScanner

② Prompt 2 — CurveTokenAnalyzer [2-3h]
   → bun run typecheck → 0 erreur
   → Test unitaire : getCurveTokenAnalyzer().analyze(fakeCurve, fakeVelocity)
   → Doit retourner en < 8s avec verdict clair

③ Prompt 3 — Intégration dans DecisionCore [1h]
   → bun run typecheck → 0 erreur
   → Test : lancer 30 min paper → vérifier que le log [EVAL] apparaît pour chaque HOT

④ Prompt 4 — Fix bugs [1h]
   → bun run typecheck → 0 erreur
   → Test : lancer 2h paper → vérifier que des outcomes apparaissent (évictions)
   → Vérifier que les positions se ferment (hard time stop visible dans logs)

⑤ Prompt 5 — Durcir GraduationPredictor [1h]
   → bun run typecheck → 0 erreur
   → TEST CRITIQUE : sur 2h, le taux d'entrée doit passer de ~40% à ~5-15%
   → Le dashboard doit montrer les vétos (ex: "bot_dominated=45 low_intensity=32")

⑥ Prompt 6 — PortfolioGuard [1h]
   → bun run typecheck → 0 erreur
   → Test : simuler 6 positions → la 6e doit être bloquée

⑦ Prompt 7 — Dashboard [30 min]
   → Test : lancer 5 min → vérifier que le dashboard s'affiche correctement

⑧ Prompt 8 — AGENTS.md [20 min]
   → Relecture manuelle des 4 corrections

⑨ Prompt 9 — Env vars [20 min]
   → Test : démarrer sans HELIUS_RPC_URL → doit exit proprement avec message clair

VALIDATION FINALE :
═══════════════════

Lancer 4h de paper trading et vérifier :
  ✅ 0 crash
  ✅ Positions ouvertes ET fermées visibles dans le dashboard
  ✅ Taux d'entrée < 15% des tokens HOT évalués
  ✅ Veto stats affichées toutes les 30 min
  ✅ Outcomes dans curve_outcomes SQLite (bun run export:ml → CSV non vide)
  ✅ Win rate > 30% (conservateur — objectif 45%+ avec dataset ML)
  ✅ Analyse complète (CurveTokenAnalyzer) visible dans logs pour chaque ENTER

QUAND CES CRITÈRES SONT ATTEINTS → lancer la collecte de données 24/7
   → Objectif : 2000+ outcomes de qualité (graduated + failed + stopped)
   → Ensuite seulement : entraîner le premier modèle LightGBM
```

---

## MÉTRIQUES DE SUCCÈS PAR PHASE

```
PHASE ACTUELLE (post-prompt 5) — Paper trading blindé
  Win Rate cible  : 30-45%
  Taux d'entrée  : < 15% des HOT
  Avg hold time  : 2-8 minutes
  Crash rate     : 0 par heure

PHASE ML (après 2000+ outcomes)
  Win Rate cible  : 45-60%
  Confidence predictor : 0.70+ (model ML vs 0.20 heuristique)
  Safety margin  : 1.16× (vs 1.64× actuellement)
  → Plus sélectif ET plus précis → entrées plus petites mais plus rentables

PHASE LIVE (après paper WR > 40% stable sur 7 jours)
  Bankroll initial : 0.5-2 SOL (conservative)
  Position size   : 0.03-0.10 SOL
  Daily target    : +0.5-1% compoundé (Sharpe > 2)
```

---

**FIN DE LA DIRECTIVE — 9 prompts Cursor, ordre précis, 0 ambiguïté.**

*Chaque prompt est auto-suffisant avec ses @file references. Exécuter dans l'ordre.*
*Valider avec `bun run typecheck` après chaque prompt avant de passer au suivant.*