# APEX-2026 V3.1 — PLAN MAÎTRE : PIPELINE 100% OPÉRATIONNEL

**Date :** 19 mars 2026  
**Classification :** Internal — Lead Quant Architect  
**Objectif :** Rendre le bot capable de : entrer, suivre, sortir, logger P&L, et avoir des "yeux partout"  
**Référence :** Fusion roadmap.md + roadmapv2.md + AUDIT.md + run paper-trading 1h52

---

## PARTIE 0 : DIAGNOSTIC — POURQUOI LE BOT NE VEND JAMAIS

### 3 Failles fatales identifiées

**FAILLE 1 — Aucun PositionManager.** `app.ts` exécute `curveExecutor.buy()` et incrémente `activeCurvePositions` (un simple `number`), mais ne stocke ni mint, ni tokenAmount, ni entryPrice, ni timestamp. Le système ne sait pas quels tokens il possède.

**FAILLE 2 — `curveUpdate` ne check que l'ENTRÉE, jamais la SORTIE.** Le handler `curveUpdate` dans `app.ts` rappelle `processCurveEvent()` qui évalue uniquement si on devrait ENTRER (pGrad vs breakeven). Il n'y a aucun code qui vérifie si une position ouverte doit être fermée.

**FAILLE 3 — Les evictions sont trop lentes.** Seules les curves COLD > 24h et progress < 10% sont evictées. Les curves WARM/HOT qui stagnent ne sont jamais evictées → 0 outcomes → dataset ML inutilisable.

---

## PARTIE 1 : LES 7 MODULES À IMPLÉMENTER (par ordre de dépendance)

```
PRIORITÉ 1 (Le bot trade de A à Z) :
  M1 → PositionManager.ts        ← RIEN n'existe, tout en dépend
  M2 → ExitEngine.ts             ← logique de vente (stop-loss, trailing, stall, time)
  M3 → GraduationExitStrategy.ts ← sortie 3 tranches sur graduation
  M4 → PaperTradeLogger.ts       ← P&L visible dans le terminal

PRIORITÉ 2 (Le bot a des yeux partout) :
  M5 → TelegramTokenScanner.ts   ← sentiment du canal TG spécifique au token
  M6 → WhaleWalletDB.ts          ← portefeuille de baleines auto-découvertes
  M7 → SocialTrendScanner.ts     ← DexScreener trending + X scraping
```

---

## MODULE M1 : PositionManager — LE COEUR MANQUANT

### Fichier : `src/modules/position/PositionManager.ts`

### CURSOR COMPOSER PROMPT

```
CONTEXT :
@file src/modules/position/PositionManager.ts (NOUVEAU)
@file src/modules/curve-tracker/CurveTracker.ts (référence — events)
@file src/modules/curve-executor/CurveExecutor.ts (référence — CurveTradeResult)
@file src/data/FeatureStore.ts (référence — appendCurveSnapshot, labelCurveOutcome)
@file src/types/bonding-curve.ts (référence — TrackedCurve, BondingCurveState)
@file src/math/curve-math.ts (référence — calcProgress, calcPricePerToken)
@codebase

OBJECTIF : Créer le module PositionManager qui track l'état de toutes les positions
ouvertes en paper trading ET en live. C'est le module central qui relie l'achat à la
vente. Sans lui, le bot achète mais ne sait jamais qu'il doit vendre.

INTERFACE CurvePosition :
  id: string                      // crypto.randomUUID()
  mint: string
  entryTimestamp: number           // Date.now() au moment du buy
  entrySolAmount: number           // SOL investis
  entryTokenAmount: bigint         // tokens reçus (depuis CurveTradeResult)
  entryProgress: number            // progress au moment de l'achat
  entryPriceSOL: number            // prix/token à l'entrée (calcPricePerToken)
  entryMarketCapSOL: number        // market cap à l'entrée
  entryPGrad: number               // pGrad du GraduationPredictor au moment de l'entrée
  entryBreakeven: number           // breakeven P(grad) au moment de l'entrée

  // État temps réel — mis à jour par updatePosition()
  currentPriceSOL: number
  currentProgress: number
  currentRealSolSOL: number
  currentMarketCapSOL: number
  lastUpdated: number

  // P&L calculé
  unrealizedPnlSOL: number        // (tokenAmount × currentPrice) - entrySol
  unrealizedPnlPct: number        // unrealizedPnlSOL / entrySol
  peakPriceSOL: number            // plus haut atteint depuis l'entrée
  peakPnlPct: number              // meilleur PnL atteint
  maxDrawdownFromPeakPct: number  // (peakPrice - currentPrice) / peakPrice

  // Statut
  status: 'OPEN' | 'CLOSING' | 'CLOSED'
  exitReason: string | null       // 'graduation' | 'stop_loss' | 'trailing_stop' |
                                  // 'stall' | 'time_stop' | 'take_profit' | 'manual'
  exitTimestamp: number | null
  exitSolReceived: number | null
  realizedPnlSOL: number | null
  realizedPnlPct: number | null
  holdDurationS: number | null

CLASSE PositionManager extends EventEmitter :

  private positions: Map<string, CurvePosition>    // mint → position ouverte
  private closedPositions: CurvePosition[]          // historique complet
  private readonly MAX_CLOSED_HISTORY = 500

  openPosition(
    mint: string,
    entrySol: number,
    entryTokens: bigint,
    curve: TrackedCurve,
    pGrad: number,
    breakeven: number,
  ): CurvePosition
    - Créer CurvePosition avec tous les champs calculés
    - Ajouter à this.positions
    - Logger "💰 [PositionManager] OPENED {mint.slice(0,8)} | {entrySol} SOL | progress={progress}%"
    - Émettre 'positionOpened'
    - Retourner la position

  updatePosition(mint: string, curve: TrackedCurve): CurvePosition | null
    - Si pas de position ouverte pour ce mint → return null
    - Mettre à jour : currentPriceSOL, currentProgress, currentRealSolSOL, currentMarketCapSOL
    - Recalculer unrealizedPnlSOL et unrealizedPnlPct :
        currentValue = Number(pos.entryTokenAmount) * curve.priceSOL
        pos.unrealizedPnlSOL = currentValue - pos.entrySolAmount
        pos.unrealizedPnlPct = pos.unrealizedPnlSOL / pos.entrySolAmount
    - Mettre à jour peakPriceSOL si currentPrice > peakPrice
    - Calculer maxDrawdownFromPeakPct = (peakPrice - currentPrice) / peakPrice
    - pos.lastUpdated = Date.now()
    - Émettre 'positionUpdated'
    - Retourner la position mise à jour

  closePosition(
    mint: string,
    reason: string,
    solReceived: number,
  ): CurvePosition | null
    - Si pas de position ouverte → return null
    - pos.status = 'CLOSED'
    - pos.exitReason = reason
    - pos.exitTimestamp = Date.now()
    - pos.exitSolReceived = solReceived
    - pos.realizedPnlSOL = solReceived - pos.entrySolAmount
    - pos.realizedPnlPct = pos.realizedPnlSOL / pos.entrySolAmount
    - pos.holdDurationS = (pos.exitTimestamp - pos.entryTimestamp) / 1000
    - Déplacer de positions vers closedPositions
    - Logger "📊 [PositionManager] CLOSED {mint} | reason={reason} | PnL={pnlPct}% | {holdDuration}s"
    - Émettre 'positionClosed'
    - Retourner la position fermée

  getOpenPositions(): CurvePosition[]
  getPosition(mint: string): CurvePosition | null
  hasOpenPosition(mint: string): boolean
  getOpenCount(): number
  getClosedPositions(): CurvePosition[]

  getPortfolioSummary(): {
    openCount: number,
    totalInvested: number,         // SOL total en positions ouvertes
    totalUnrealizedPnl: number,    // SOL
    totalUnrealizedPnlPct: number,
    totalRealizedPnl: number,      // SOL (from closed)
    winRate: number,               // % des trades closed avec PnL > 0
    avgHoldDurationS: number,
    avgPnlPct: number,
    bestTrade: CurvePosition | null,
    worstTrade: CurvePosition | null,
  }

EXPORT : Singleton via getPositionManager()

RÈGLES :
- Pas de 'any'. Typage strict.
- Toutes les divisions protégées contre division par zéro
- Ne JAMAIS crasher — try/catch sur tous les calculs
- Logger avec émojis et temps en ms
- Le PositionManager ne décide PAS de vendre — il fournit l'état.
  La décision de vente est dans ExitEngine (M2).
```

---

## MODULE M2 : ExitEngine — LA LOGIQUE DE VENTE

### Fichier : `src/modules/position/ExitEngine.ts`

### CURSOR COMPOSER PROMPT

```
CONTEXT :
@file src/modules/position/ExitEngine.ts (NOUVEAU)
@file src/modules/position/PositionManager.ts (M1 — CurvePosition interface)
@file src/modules/graduation-predictor/VelocityAnalyzer.ts (référence — VelocitySignal)
@file src/modules/curve-tracker/CurveTracker.ts (référence — TrackedCurve)
@file src/types/bonding-curve.ts
@codebase

OBJECTIF : Module qui évalue en continu les positions ouvertes et décide quand vendre.
Appelé à CHAQUE curveUpdate pour les mints qui ont une position ouverte.
C'est le "cerveau de sortie" — complémentaire du GraduationPredictor qui est le
"cerveau d'entrée".

INTERFACE ExitSignal :
  mint: string
  reason: 'graduation' | 'stop_loss' | 'trailing_stop' | 'stall' |
          'time_stop' | 'take_profit' | 'velocity_collapse'
  action: 'SELL_100PCT' | 'SELL_50PCT' | 'GRADUATION_EXIT_3TRANCHE'
  urgency: 'CRITICAL' | 'HIGH' | 'MEDIUM'
  detail: string             // human-readable explanation
  positionPnlPct: number     // current PnL% at time of signal

CLASSE ExitEngine :

  // Configuration depuis process.env avec defaults raisonnables
  private readonly STOP_LOSS_PCT: number           // default -0.15 (-15%)
  private readonly TRAILING_STOP_PCT: number       // default 0.20 (20% from peak)
  private readonly TAKE_PROFIT_PCT: number         // default 0.50 (+50%)
  private readonly MAX_HOLD_TIME_MS: number        // default 7_200_000 (2h)
  private readonly STALL_VELOCITY_THRESHOLD: number // default 0.2
  private readonly STALL_SOL_FLOW_MIN: number      // default 0.1 SOL/min
  private readonly VELOCITY_COLLAPSE_RATIO: number // default 0.3 (70% drop)

  constructor() :
    - Lire tous les seuils depuis process.env avec parseFloat et defaults
    - Logger tous les seuils au démarrage

  evaluate(
    position: CurvePosition,
    curve: TrackedCurve,
    velocity: VelocitySignal,  // du VelocityAnalyzer
  ): ExitSignal | null

    // PRIORITÉ 1 : GRADUATION (immediate exit en 3 tranches)
    if (curve.state.complete === true || curve.progress >= 0.99) :
      return { reason: 'graduation', action: 'GRADUATION_EXIT_3TRANCHE', urgency: 'CRITICAL' }

    // PRIORITÉ 2 : STOP LOSS HARD (-15% par défaut)
    if (position.unrealizedPnlPct < -this.STOP_LOSS_PCT) :
      return { reason: 'stop_loss', action: 'SELL_100PCT', urgency: 'CRITICAL' }

    // PRIORITÉ 3 : TRAILING STOP (20% chute depuis le peak, seulement si en profit)
    if (position.peakPnlPct > 0.10 && position.maxDrawdownFromPeakPct > this.TRAILING_STOP_PCT) :
      return { reason: 'trailing_stop', action: 'SELL_100PCT', urgency: 'HIGH' }

    // PRIORITÉ 4 : VELOCITY COLLAPSE (momentum meurt brutalement)
    if (velocity.velocityRatio < this.VELOCITY_COLLAPSE_RATIO
        && velocity.velocityAcceleration < -0.5
        && velocity.solPerMinute_1m < this.STALL_SOL_FLOW_MIN) :
      // Si en profit → take profit
      if (position.unrealizedPnlPct > 0.05) :
        return { reason: 'velocity_collapse', action: 'SELL_100PCT', urgency: 'HIGH' }
      // Si en perte modérée → cut early
      if (position.unrealizedPnlPct < -0.05) :
        return { reason: 'velocity_collapse', action: 'SELL_100PCT', urgency: 'MEDIUM' }

    // PRIORITÉ 5 : STALL (momentum mort depuis > 2 minutes)
    if (velocity.velocityRatio < this.STALL_VELOCITY_THRESHOLD
        && velocity.solPerMinute_1m < this.STALL_SOL_FLOW_MIN) :
      return { reason: 'stall', action: 'SELL_100PCT', urgency: 'MEDIUM' }

    // PRIORITÉ 6 : TIME STOP (position ouverte > 2h)
    if (Date.now() - position.entryTimestamp > this.MAX_HOLD_TIME_MS) :
      return { reason: 'time_stop', action: 'SELL_100PCT', urgency: 'MEDIUM' }

    // PRIORITÉ 7 : TAKE PROFIT progressif (+50% et momentum faiblit)
    if (position.unrealizedPnlPct > this.TAKE_PROFIT_PCT
        && velocity.velocityRatio < 0.5) :
      return { reason: 'take_profit', action: 'SELL_50PCT', urgency: 'MEDIUM' }

    return null  // HOLD — pas de signal de sortie

EXPORT : Singleton via getExitEngine()

RÈGLES :
- Chaque condition est INDÉPENDANTE et ordonnée par urgence
- GRADUATION est toujours priorité absolue (même si PnL est négatif)
- STOP LOSS est NON NÉGOCIABLE — jamais désactivé
- Le trailing stop ne s'active qu'après un profit de +10% minimum
  (évite les faux triggers sur du bruit)
- Logger chaque signal : "🚨 [ExitEngine] {mint} → {reason} | PnL={pnl}% | {detail}"

VARIABLES D'ENVIRONNEMENT (.env) :
  STOP_LOSS_PCT=0.15
  TRAILING_STOP_PCT=0.20
  TAKE_PROFIT_PCT=0.50
  MAX_HOLD_TIME_MINUTES=120
  STALL_VELOCITY_THRESHOLD=0.2
  STALL_SOL_FLOW_MIN=0.1
```

---

## MODULE M3 : GraduationExitStrategy — SORTIE 3 TRANCHES

### Fichier : `src/modules/curve-executor/GraduationExitStrategy.ts`

### CURSOR COMPOSER PROMPT

```
CONTEXT :
@file src/modules/curve-executor/GraduationExitStrategy.ts (NOUVEAU)
@file src/modules/curve-executor/CurveExecutor.ts (référence — sell())
@file src/modules/position/PositionManager.ts (référence — CurvePosition)
@codebase

OBJECTIF : Quand curve.complete === true (le token gradué), exécuter une sortie
en 3 tranches. Seulement 30% des tokens gradués maintiennent leur market cap sur
PumpSwap — sortie agressive obligatoire.

STRATÉGIE 3 TRANCHES (papier arXiv + best practices) :

  Tranche 1 : Vendre 40% IMMÉDIATEMENT (< 1 seconde)
    → Exécuter sell sur la bonding curve si encore possible
    → Sinon : sell via PumpSwap/Raydium (le token a migré)
    → LOG : "🎓 [GradExit] T1: Sold 40% of {mint} | {solReceived} SOL"

  Tranche 2 : Vendre 30% après DELAY_T2_MS (default: 900_000 = 15 minutes)
    → setTimeout(() => executor.sell(mint, tokens * 0.30), DELAY_T2_MS)
    → À ce moment le token est sur PumpSwap — utiliser Jupiter ou Raydium
    → LOG : "🎓 [GradExit] T2: Sold 30% of {mint} | {solReceived} SOL"

  Tranche 3 : Garder 30% avec TRAILING STOP dynamique à 20% du peak
    → Monitor le prix post-graduation (via DexScreener polling ou on-chain)
    → Si prix chute de 20% depuis le peak post-graduation → sell tout
    → Si prix monte > 3× graduation price → sell tout (take massive profit)
    → MAX HOLD T3 = 1 heure après graduation
    → LOG : "🎓 [GradExit] T3: {action} 30% of {mint} | {solReceived} SOL"

CLASSE GraduationExitStrategy :

  async executeGraduationExit(
    position: CurvePosition,
    executor: CurveExecutor,
  ): Promise<GraduationExitResult>

  PAPER MODE :
    - En paper trading : ne pas appeler executor.sell() réellement
    - Simuler les 3 tranches avec les prix actuels
    - Logger comme si c'était réel
    - Calculer le P&L total des 3 tranches

  INTERFACE GraduationExitResult :
    mint: string
    tranche1Executed: boolean
    tranche1SolReceived: number
    tranche2Scheduled: boolean
    tranche2SolReceived: number | null   // null si pas encore exécuté
    tranche3MonitorActive: boolean
    totalSolRecovered: number
    totalPnlSOL: number
    totalPnlPct: number

RÈGLES :
- Tranche 1 est FIRE-AND-FORGET — ne JAMAIS attendre la confirmation pour
  commencer à planifier T2 et T3
- Si T1 échoue (tx fail) → réessayer 1x puis passer à T2 avec 70%
- Les timers T2/T3 doivent survivre aux reconnexions WS
- En paper mode : estimer le slippage à 2% par tranche (réaliste post-grad)
```

---

## MODULE M4 : Wiring app.ts + Dashboard P&L

### CURSOR COMPOSER PROMPT

```
CONTEXT :
@file src/app.ts (MODIFICATION)
@file src/modules/position/PositionManager.ts (M1)
@file src/modules/position/ExitEngine.ts (M2)
@file src/modules/curve-executor/GraduationExitStrategy.ts (M3)
@file src/modules/curve-tracker/CurveTracker.ts
@file src/modules/graduation-predictor/VelocityAnalyzer.ts
@codebase

OBJECTIF : Wirer le PositionManager, ExitEngine et GraduationExitStrategy dans app.ts
pour que le cycle de vie complet d'un trade fonctionne : ENTER → MONITOR → EXIT → P&L.

CHANGEMENTS DANS app.ts :

1. IMPORTS :
  import { getPositionManager } from './modules/position/PositionManager.js';
  import { getExitEngine } from './modules/position/ExitEngine.js';
  import { GraduationExitStrategy } from './modules/curve-executor/GraduationExitStrategy.js';

2. DANS LE HANDLER enterHotZone, après curveExecutor.buy() réussi :
  AVANT :
    this.stats.tokensSniped++;
  APRÈS :
    this.stats.tokensSniped++;
    getPositionManager().openPosition(
      mint,
      decision.positionSol,
      result.tokenAmount,
      curve,
      decision.pGrad,
      decision.breakeven,
    );

3. NOUVEAU HANDLER curveUpdate pour les positions ouvertes :
  curveTracker.on('curveUpdate', async (mint: string, curve: TrackedCurve) => {
    const pm = getPositionManager();
    const position = pm.getPosition(mint);

    if (position && position.status === 'OPEN') {
      // Mettre à jour l'état de la position
      pm.updatePosition(mint, curve);

      // Évaluer si on doit sortir
      const trades = curveTracker.getTradeHistory(mint);
      const velocity = new VelocityAnalyzer().analyze(mint, trades);
      const exitSignal = getExitEngine().evaluate(position, curve, velocity);

      if (exitSignal) {
        if (exitSignal.action === 'GRADUATION_EXIT_3TRANCHE') {
          const gradExit = new GraduationExitStrategy();
          await gradExit.executeGraduationExit(position, this.curveExecutor!);
        } else {
          // Calculer le montant à vendre
          const pctToSell = exitSignal.action === 'SELL_50PCT' ? 0.5 : 1.0;
          const tokensToSell = BigInt(
            Math.floor(Number(position.entryTokenAmount) * pctToSell)
          );

          const result = await this.curveExecutor!.sell(
            mint, tokensToSell, 500,
            curve.state.virtualSolReserves,
            curve.state.virtualTokenReserves,
          );

          if (result.success) {
            pm.closePosition(mint, exitSignal.reason, result.solAmount);
            this.decisionCore.updateActivePositions(-1);
          }
        }
      }
    }

    // Continuer l'évaluation d'entrée pour les curves sans position
    if (!pm.hasOpenPosition(mint) && curve.tier === 'hot') {
      const trades = curveTracker.getTradeHistory(mint);
      await this.decisionCore.processCurveEvent(curve, trades);
    }
  });

4. HANDLER graduated avec GraduationExitStrategy :
  curveTracker.on('graduated', async (mint: string, curve: TrackedCurve) => {
    const pm = getPositionManager();
    const position = pm.getPosition(mint);

    if (position && position.status === 'OPEN') {
      const gradExit = new GraduationExitStrategy();
      await gradExit.executeGraduationExit(position, this.curveExecutor!);
    }

    // Labellisation existante (garder)
    getFeatureStore().labelCurveOutcome({ ... });
  });

5. DASHBOARD amélioré dans displayDashboard() :
  Ajouter après la section CurveTracker :

  const pm = getPositionManager();
  const portfolio = pm.getPortfolioSummary();
  console.log('');
  console.log('💼 Paper Portfolio:');
  console.log(`   Bankroll: ${bankroll.toFixed(3)} SOL | Invested: ${portfolio.totalInvested.toFixed(3)} SOL`);
  console.log(`   Open: ${portfolio.openCount} | Unrealized: ${portfolio.totalUnrealizedPnl >= 0 ? '+' : ''}${portfolio.totalUnrealizedPnl.toFixed(4)} SOL (${(portfolio.totalUnrealizedPnlPct*100).toFixed(1)}%)`);
  for (const pos of pm.getOpenPositions()) {
    const emoji = pos.unrealizedPnlPct >= 0 ? '📈' : '📉';
    console.log(`   ${emoji} ${pos.mint.slice(0,8)} | ${pos.entrySolAmount.toFixed(3)} SOL | progress ${(pos.currentProgress*100).toFixed(0)}% | PnL: ${(pos.unrealizedPnlPct*100).toFixed(1)}%`);
  }
  console.log(`   Closed: ${closedCount} | W:${wins} L:${losses} = ${(portfolio.winRate*100).toFixed(0)}% WR`);
  console.log(`   Realized P&L: ${portfolio.totalRealizedPnl >= 0 ? '+' : ''}${portfolio.totalRealizedPnl.toFixed(4)} SOL`);
  if (portfolio.bestTrade) console.log(`   Best: +${(portfolio.bestTrade.realizedPnlPct!*100).toFixed(1)}% (${portfolio.bestTrade.mint.slice(0,8)})`);
  if (portfolio.worstTrade) console.log(`   Worst: ${(portfolio.worstTrade.realizedPnlPct!*100).toFixed(1)}% (${portfolio.worstTrade.mint.slice(0,8)})`);

6. FIX EVICTION : Dans TieredMonitor, ajouter des evictions plus agressives :
  - WARM curves > 2h sans changement de progress > 2% → evict
  - HOT curves > 30min avec velocityRatio < 0.1 → evict
  - Toute curve avec progress qui RÉGRESSE (gens vendent) → evict immédiatement
```

---

## MODULE M5 : TelegramTokenScanner — SENTIMENT PAR TOKEN

### Fichier : `src/ingestors/TelegramTokenScanner.ts`

### CURSOR COMPOSER PROMPT

```
CONTEXT :
@file src/ingestors/TelegramTokenScanner.ts (NOUVEAU)
@file src/ingestors/TelegramPulse.ts (référence — GramJS patterns)
@file src/nlp/NLPPipeline.ts (référence — process())
@file src/nlp/ViralityScorer.ts (référence — compute())
@codebase

OBJECTIF : Quand un token entre en HOT zone, trouver automatiquement son canal
Telegram et analyser le sentiment en temps réel.

STRATÉGIE DE DÉCOUVERTE DU LIEN TELEGRAM :

  1. DexScreener API (gratuit, priorité) :
     GET https://api.dexscreener.com/latest/dex/tokens/{mint}
     → data.pairs[0]?.info?.socials → chercher type: 'telegram'
     → Timeout 3s, try/catch silencieux

  2. Métadonnées on-chain (fallback) :
     → Dériver le Metadata PDA (Metaplex) du mint
     → Fetch le JSON à l'URI des métadonnées
     → Chercher "telegram", "tg", "t.me" dans le JSON
     → Timeout 5s

  3. Si aucun lien → socialScore = 0 (neutre, pas de véto)

ANALYSE DU CANAL TELEGRAM :

  async analyzeTelegramChannel(url: string, mint: string): Promise<TokenSocialScore>
    - Se connecter au channel via le client GramJS existant (TelegramPulse.client)
    - Si channel privé → rejoindre (JoinChannel)
    - Lire les 50 derniers messages (GetHistory)
    - Pour chaque message :
      → NLPPipeline.process(message.text, mint, 'Telegram')
      → Collecter sentiments
    - Calculer :
      messagesPerMinute: nombre de messages dans les 5 dernières minutes
      avgSentiment: moyenne des sentiments (-1 à 1)
      memberCount: channel.participantsCount
      adminActive: est-ce que l'admin a posté récemment ?
      redFlags: ["rug", "scam", "sell", "dump"] détectés
      engagementScore: messagesPerMinute * memberCount / 1000

  INTERFACE TokenSocialScore :
    mint: string
    telegramUrl: string | null
    messagesPerMinute: number
    avgSentiment: number          // -1 à 1
    memberCount: number
    adminActive: boolean
    redFlagCount: number
    engagementScore: number       // 0-1 normalisé
    compositeScore: number        // 0-1 — score final pour le GraduationPredictor
    analyzedAt: number

  VÉTOS SOCIAUX :
    - Si redFlagCount >= 3 → compositeScore = 0 (véto absolu)
    - Si memberCount < 10 → compositeScore *= 0.3 (pas de communauté)
    - Si adminActive = false et age > 30min → compositeScore *= 0.5

INTÉGRATION AVEC GraduationPredictor :
  - Le compositeScore remplace le socialScore (actuellement toujours 0)
  - Poids dans la formule : W_SOCIAL = 0.10 → augmenter à 0.15
  - Le scan est lancé UNE FOIS quand la curve entre en HOT (pas à chaque poll)
  - Résultat caché en mémoire pour les réévaluations suivantes

RATE LIMITS :
  - Max 1 channel join par 10s (Telegram rate limit)
  - Max 5 channels scannés simultanément
  - GetHistory throttlé à 1 req/3s
  - Si TelegramPulse est inactif → skip silencieusement (score = 0)

RISQUE : Telegram peut ban le compte si trop de joins.
  → Ne rejoindre QUE les channels publics
  → Throttle agressif
  → Préférer GetHistory sans join si le channel est public
```

---

## MODULE M6 : WhaleWalletDB — PORTEFEUILLE DE BALEINES

### Fichier : `src/data/WhaleWalletDB.ts` + `scripts/discover-whales.ts`

### CURSOR COMPOSER PROMPT

```
CONTEXT :
@file src/data/WhaleWalletDB.ts (NOUVEAU)
@file src/ingestors/SmartMoneyTracker.ts (référence — WalletProfile, addWallets())
@file src/data/FeatureStore.ts (référence — pattern SQLite bun:sqlite)
@file src/modules/graduation-predictor/WalletScorer.ts (référence — setSmartMoneyList)
@codebase

OBJECTIF : Créer une base de données persistante de wallets "baleines" qui est
auto-alimentée par l'analyse des graduations passées. Au démarrage du bot, les
baleines connues sont chargées dans SmartMoneyTracker.

SCHÉMA SQLite (même DB que FeatureStore, table séparée) :

CREATE TABLE IF NOT EXISTS whale_wallets (
  address         TEXT PRIMARY KEY,
  label           TEXT NOT NULL DEFAULT 'unknown',
  trust_score     REAL NOT NULL DEFAULT 0.5,
  tokens_bought   INTEGER NOT NULL DEFAULT 0,
  tokens_graduated INTEGER NOT NULL DEFAULT 0,
  total_sol_invested REAL NOT NULL DEFAULT 0,
  total_sol_returned REAL NOT NULL DEFAULT 0,
  win_rate        REAL NOT NULL DEFAULT 0,
  avg_entry_progress REAL NOT NULL DEFAULT 0,
  last_seen_ms    INTEGER NOT NULL DEFAULT 0,
  discovered_via  TEXT NOT NULL DEFAULT 'manual',
  notes           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whale_trust ON whale_wallets(trust_score DESC);
CREATE INDEX IF NOT EXISTS idx_whale_winrate ON whale_wallets(win_rate DESC);

CLASSE WhaleWalletDB :

  constructor(db: Database)  // réutiliser le bun:sqlite du FeatureStore

  addWhale(address: string, label: string, discoveredVia: string): void
  updateWhaleStats(address: string, graduated: boolean, solInvested: number, solReturned: number): void
  getTopWhales(limit: number = 100): WhaleWallet[]
  getWhale(address: string): WhaleWallet | null
  isWhale(address: string): boolean
  getWhaleCount(): number

  // Appelé au démarrage du bot
  loadIntoSmartMoneyTracker(): void
    → const whales = this.getTopWhales(100)
    → const profiles: WalletProfile[] = whales.map(w => ({
        address: w.address,
        trustScore: w.trust_score,
        label: w.label,
        lastSeen: w.last_seen_ms,
      }))
    → getSmartMoneyTracker().addWallets(profiles)
    → getGraduationPredictor().setSmartMoneyList(whales.map(w => w.address))
    → Logger "🐋 [WhaleDB] Loaded {N} whales into SmartMoneyTracker"

SCRIPT scripts/discover-whales.ts (équivalent `scripts/seed-whales.ts`, `bun run discover:whales`) :

  Algorithme de découverte rétroactive :
  1. Récupérer les tokens gradués depuis curve_outcomes WHERE graduated = 1
  2. Pour chaque token gradué :
     → Récupérer les early buyers (trades dans curve_snapshots avec progress < 0.50)
     → OU : Helius getSignaturesForAddress(curvePDA) → parser les transactions
  3. Compter combien de tokens chaque wallet a acheté ET combien ont gradué
  4. Si graduated / bought >= 0.3 (30%+ win rate) ET bought >= 3 → WHALE
  5. trust_score = graduated / bought × confidence(bought)
     → confidence(n) = 1 - exp(-n/5)  // plus de trades = plus confiant
  6. Insérer dans whale_wallets

  Utiliser :
  - Helius Enhanced Transactions API (gratuit, rate limited)
  - getSignaturesForAddress pour lister les interactions avec les bonding curves

  RATE LIMITS : Max 5 req/s sur Helius free tier. Throttle via Promise + setTimeout.

  Exécution : bun scripts/discover-whales.ts
  → À lancer manuellement après 24-48h de collecte (quand outcomes > 0)
  → Plus tard : cron toutes les 6h
```

---

## MODULE M7 : SocialTrendScanner — YEUX PARTOUT

### Fichier : `src/ingestors/SocialTrendScanner.ts`

### CURSOR COMPOSER PROMPT

```
CONTEXT :
@file src/ingestors/SocialTrendScanner.ts (NOUVEAU)
@file src/nlp/NLPPipeline.ts (référence)
@file src/nlp/ViralityScorer.ts (référence)
@file src/modules/curve-tracker/CurveTracker.ts (référence — registerNewCurve)
@codebase

OBJECTIF : Scanner les sources sociales gratuites pour détecter les tokens qui
buzzbent AVANT qu'ils n'arrivent en HOT zone. C'est un système d'alerte précoce.

3 SOURCES GRATUITES :

SOURCE 1 — DexScreener Token Boosts (nouveau tokens trending)
  Endpoint : GET https://api.dexscreener.com/token-boosts/latest/v1
  Poll : toutes les 30s
  Parse : chercher les tokens Solana avec "chainId": "solana"
  Si le token est sur Pump.fun ET pas encore dans CurveTracker → alerte
  Si le token est déjà dans CurveTracker et en COLD/WARM → force promote HOT

SOURCE 2 — DexScreener Token Profiles (tokens avec métadonnées payées)
  Endpoint : GET https://api.dexscreener.com/token-profiles/latest/v1
  Poll : toutes les 60s
  Si un token a payé pour un profil DexScreener → signal positif (le dev investit)

SOURCE 3 — PumpPortal WebSocket (déjà dans l'écosystème)
  wss://pumpportal.fun/api/data
  Événements : newToken (création), tokenTrade (achat/vente)
  Utiliser comme source supplémentaire de trades pour VelocityAnalyzer
  Avantage : plus rapide que logsSubscribe pour certains événements

CLASSE SocialTrendScanner extends EventEmitter :

  private dexScreenerInterval: ReturnType<typeof setInterval> | null
  private pumpPortalWs: WebSocket | null
  private knownBoosts: Set<string>         // éviter les doublons
  private readonly BOOST_POLL_MS = 30_000
  private readonly PROFILE_POLL_MS = 60_000

  async start(): Promise<void>
    - Démarrer le polling DexScreener (fetch + parse)
    - Connecter PumpPortal WebSocket
    - Logger "🔍 [SocialTrend] Started — DexScreener + PumpPortal"

  private async pollDexScreenerBoosts(): Promise<void>
    - fetch avec timeout 5s et try/catch
    - Pour chaque token Solana trouvé :
      → Si pas dans knownBoosts → émettre 'socialBoost' avec le mint
      → Ajouter à knownBoosts (max 10000, LRU evict)

  private connectPumpPortal(): void
    - WebSocket vers wss://pumpportal.fun/api/data
    - Sur message 'tokenTrade' :
      → Si le token est tracked par CurveTracker → enrichir trade history
      → curveTracker.recordTrade({ mint, isBuy, solAmount, trader, ... })

  Événements émis :
    'socialBoost': (mint: string, source: 'dexscreener_boost' | 'dexscreener_profile')
    'pumpPortalTrade': (trade: CurveTradeEvent)

  async stop(): void
    - Clear intervals
    - Close WebSocket

INTÉGRATION dans app.ts :
  const socialScanner = new SocialTrendScanner();
  await socialScanner.start();

  socialScanner.on('socialBoost', (mint, source) => {
    const ct = getCurveTracker();
    if (ct.getCurveState(mint)) {
      ct.forcePromoteHot(mint); // Déjà tracked → prioritize
    } else {
      // Nouveau token trending → enregistrer
      ct.registerNewCurve(mint, 'unknown', { name: source });
    }
  });

  socialScanner.on('pumpPortalTrade', (trade) => {
    getCurveTracker().recordTrade(trade);
  });
```

---

## PARTIE 2 : FIX DU PIPELINE DE DONNÉES (Outcomes)

### CURSOR COMPOSER PROMPT — Fix TieredMonitor evictions

```
CONTEXT :
@file src/modules/curve-tracker/TieredMonitor.ts (MODIFICATION)
@codebase

OBJECTIF : Les evictions sont trop lentes — seules les curves COLD > 24h sont evictées.
Résultat : 0 outcomes en 2h de run. Il faut des evictions beaucoup plus agressives.

CHANGEMENTS DANS demoteOrEvict() :

  AJOUTER ces règles d'eviction (en plus des existantes) :

  // HOT curves qui stagnent
  if (curve.tier === 'hot') {
    const ageMinutes = (now - curve.createdAt) / 60_000;
    const lastChange = (now - curve.lastUpdated) / 60_000;

    // HOT > 30min sans changement de progress significatif (< 1%)
    if (ageMinutes > 30 && lastChange > 5) {
      // Vérifier si le progress a bougé de plus de 1% dans les 5 dernières minutes
      // Si non → stalled → evict
      this.evict(mint, 'hot_stalled_30min');
      return;
    }

    // HOT > 60min dans tous les cas
    if (ageMinutes > 60) {
      this.evict(mint, 'hot_timeout_60min');
      return;
    }
  }

  // WARM curves qui ne progressent pas
  if (curve.tier === 'warm') {
    const ageMinutes = (now - curve.createdAt) / 60_000;

    // WARM > 2h sans atteindre HOT
    if (ageMinutes > 120) {
      this.evict(mint, 'warm_timeout_2h');
      return;
    }

    // WARM > 30min et progress a REGRESSÉ (gens vendent)
    if (ageMinutes > 30 && curve.progress < 0.20) {
      this.evict(mint, 'warm_regressed');
      return;
    }
  }

  // COLD curves — timer plus court
  if (curve.tier === 'cold') {
    const ageMinutes = (now - curve.createdAt) / 60_000;

    // COLD > 2h (au lieu de 24h) et progress < 15%
    if (ageMinutes > 120 && curve.progress < 0.15) {
      this.evict(mint, 'cold_stale_2h');
      return;
    }
  }

  // Toute curve dont le progress RÉGRESSE sous 5%
  if (curve.progress < 0.05 && (now - curve.createdAt) > 600_000) {
    this.evict(mint, 'progress_collapsed');
    return;
  }

  AJOUTER la méthode evict() si elle n'existe pas :
  private evict(mint: string, reason: string): void {
    this.cold.delete(mint);
    this.warm.delete(mint);
    this.hot.delete(mint);
    this.batchPoller.unregister(mint);
    this.emit('evicted', mint, reason);
  }

  AJOUTER un timer d'eviction check toutes les 60s :
  Dans start() :
    this.evictionInterval = setInterval(() => {
      for (const [mint, curve] of [...this.cold, ...this.warm, ...this.hot]) {
        this.demoteOrEvict(mint);
      }
    }, 60_000);
```

---

## PARTIE 3 : SEUILS DU GRADUATION PREDICTOR (Fix 100% enter rate)

### CURSOR COMPOSER PROMPT

```
CONTEXT :
@file src/modules/graduation-predictor/GraduationPredictor.ts (MODIFICATION)
@codebase

OBJECTIF : Le predictor entre sur 100% des curves HOT (6/6). Pas assez sélectif.
Durcir les vétos et augmenter le safety margin.

CHANGEMENTS :

1. AUGMENTER le safety margin du breakeven :
   AVANT : const SAFETY_MARGIN = 1.2;   // 20% au-dessus du breakeven
   APRÈS : const SAFETY_MARGIN = 1.5;   // 50% au-dessus du breakeven

2. AJOUTER un véto sur le tradeCount minimum :
   Dans predict(), après les vétos existants, ajouter :
   if (buyCount < 10) {
     vetoReason = `insufficient_trades: ${buyCount} < 10 (need microstructure)`;
   }

3. AJOUTER un véto sur l'âge minimum en HOT :
   const minutesInHot = (Date.now() - curve.lastPromotedToHot) / 60_000;
   if (minutesInHot < 2) {
     vetoReason = `too_early_in_hot: ${minutesInHot.toFixed(1)}min < 2min (need data)`;
   }

4. DURCIR le fallback heuristique (predictFromCurveState) :
   AVANT : const confidence = 0.35;
   APRÈS : const confidence = 0.20;  // basse confiance → Kelly donne petite position

   AJOUTER un véto dans le fallback :
   if (curve.progress < 0.55) {
     return { pGrad: 0, action: 'SKIP', vetoReason: 'heuristic_too_early' };
   }

5. LOGGER les vétos dans les stats :
   Ajouter un compteur de vétos par raison pour le dashboard.
```

---

## PARTIE 4 : RÉSUMÉ D'IMPLÉMENTATION — ORDRE D'EXÉCUTION

```
JOUR 1 — Le bot sait vendre (PRIORITÉ ABSOLUE)
═══════════════════════════════════════════════
  ① PositionManager.ts           [M1] — 2-3h
  ② ExitEngine.ts                [M2] — 1-2h
  ③ GraduationExitStrategy.ts    [M3] — 1-2h
  ④ Wiring app.ts                [M4] — 1-2h
  ⑤ Fix TieredMonitor evictions  [P2] — 30min
  ⑥ Fix GraduationPredictor      [P3] — 30min

  TEST : Lancer 2h de paper trading → vérifier :
    ✓ Le dashboard affiche les positions ouvertes avec P&L
    ✓ Des positions se ferment (stop-loss, stall, time)
    ✓ Des outcomes apparaissent (évictions agressives)
    ✓ Le win rate est calculable

JOUR 2 — Le bot a des yeux
═══════════════════════════════════════════════
  ⑦ SocialTrendScanner.ts        [M7] — 2h (le plus facile)
  ⑧ TelegramTokenScanner.ts      [M5] — 3h (si TG credentials dispo)
  ⑨ WhaleWalletDB.ts             [M6] — 2h (schéma + loader)

  TEST : Lancer 4h → vérifier :
    ✓ DexScreener boosts détectés et force-promote HOT
    ✓ Sentiment Telegram visible dans les logs pour les HOT curves
    ✓ WhaleDB chargée au démarrage (même si vide)

JOUR 3 — Le bot découvre les baleines
═══════════════════════════════════════════════
  ⑩ scripts/discover-whales.ts   [M6] — 2h
  ⑪ Backfill outcomes            — 1h (si données de JOUR 1-2)
  ⑫ Premier analyse du dataset

SEMAINE 2+ — ML
═══════════════════════════════════════════════
  → Exporter curve_snapshots + curve_outcomes
  → Premier XGBoost sur les features
  → A/B test heuristique vs ML en shadow mode
```

---

## PARTIE 5 : VARIABLES D'ENVIRONNEMENT COMPLÈTES

```env
# ═══ Stratégie ═══
STRATEGY_MODE=curve-prediction
TRADING_MODE=paper

# ═══ RPC ═══
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
QUICKNODE_RPC_URL=https://...

# ═══ Entrée ═══
CURVE_ENTRY_MIN_PROGRESS=0.50
CURVE_ENTRY_MAX_PROGRESS=0.80
CURVE_MIN_PGRAD=0.55
SAFETY_MARGIN=1.5
MIN_TRADE_COUNT=10

# ═══ Sortie ═══
STOP_LOSS_PCT=0.15
TRAILING_STOP_PCT=0.20
TAKE_PROFIT_PCT=0.50
MAX_HOLD_TIME_MINUTES=120
STALL_VELOCITY_THRESHOLD=0.2
STALL_SOL_FLOW_MIN=0.1

# ═══ Risk ═══
MAX_CONCURRENT_CURVE_POSITIONS=5
MAX_TOTAL_CURVE_EXPOSURE_PCT=0.20
DAILY_LOSS_LIMIT_PCT=0.05
KELLY_FRACTION=0.25
MAX_POSITION_PCT=0.05
MIN_POSITION_SOL=0.05
PAPER_BANKROLL_SOL=1.0

# ═══ Wallet ═══
WALLET_PRIVATE_KEY=...   # 64-byte Base58 ou JSON array

# ═══ Social ═══
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...
TELEGRAM_SESSION_STRING=...
GROQ_API_KEY=...

# ═══ Jito ═══
JITO_BLOCK_ENGINE_URL=https://amsterdam.mainnet.block-engine.jito.wtf
JITO_TIP_LAMPORTS=50000
```

---

**FIN DU DOCUMENT — 7 modules, 6 prompts Cursor, 3 jours d'implémentation.**