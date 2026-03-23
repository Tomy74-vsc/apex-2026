# APEX-2026 — DIRECTIVE CURSOR COMPOSER 2 : PHASE C
# Social Intelligence + Stratégie Quant + Pipeline ML

**Date :** 23 mars 2026  
**Pré-requis :** Phase A (PositionManager/ExitEngine/GradExit) ✅ Phase B (EntryFilter/evictions) ✅  
**Objectif :** Implémenter les 5 couches d'intelligence, activer Telegram, connecter Grok X Search, collecter des données de qualité pour entraîner le modèle ML  
**Référence :** `APEX_QUANT_STRATEGY.md` §5-§9, `compass_artifact` §2A-2C, `roadmapv3.md` M5-M7

---

## CE QUI EXISTE ET MARCHE (ne pas toucher)

- PositionManager + SQLite persist + restore on boot
- ExitEngine (stop-loss, trailing, stall, time-stop, graduation, velocity collapse)
- GraduationExitStrategy (3 tranches T1/T2/T3)
- EntryFilter (velocity gate + trivial tx ratio)
- PaperTradeLogger (data/paper_trades.jsonl)
- PumpScanner (0 reconnects, 191 tokens/40min)
- CurveTracker + TieredMonitor + BatchPoller (evictions actives)
- GraduationPredictor (heuristique + vétos)
- NLPPipeline 3-stage Groq (Stage0 regex + Stage1 Llama-8B + Stage2 Llama-70B)
- SmartMoneyTracker (structure prête, 0 wallets chargées)
- ViralityScorer (time-decay mentions)
- FeatureStore (curve_snapshots + curve_outcomes tables)

---

## IMPLÉMENTATION 1 : GROK X SEARCH — Analyse sociale par token + Radar narratif

### Prompt Cursor Composer 2

```
@codebase
@file src/social/GrokXScanner.ts (NOUVEAU — créer le fichier)
@file src/social/NarrativeRadar.ts (NOUVEAU — créer le fichier)  
@file src/social/SentimentAggregator.ts (NOUVEAU — créer le fichier)
@file src/modules/graduation-predictor/GraduationPredictor.ts (MODIFIER — intégrer socialScore)
@file src/app.ts (MODIFIER — wiring)
@file src/nlp/NLPPipeline.ts (référence)
@file src/nlp/ViralityScorer.ts (référence)

Créer 3 nouveaux fichiers pour l'intelligence sociale via Grok API avec
X Search intégrée. L'API Grok est compatible OpenAI (même format).
Coût estimé : ~$4/jour, couvert par $150/mois de crédits gratuits xAI.

═══ FICHIER 1 : src/social/GrokXScanner.ts ═══

import { EventEmitter } from 'events';

Interface TokenXSentiment {
  mentionCount: number;       // tweets last 30min
  sentiment: number;          // -1 bearish → 1 bullish
  hypeLevel: number;          // 0 dead → 10 viral
  botActivity: number;        // 0 organic → 1 pure bot
  influencerMentions: number; // accounts > 10K followers
  keyThemes: string[];        // max 3
  confidence: number;         // 0 → 1
  fromCache: boolean;
  latencyMs: number;
}

Classe GrokXScanner :

  private readonly apiKey = process.env.XAI_API_KEY ?? '';
  private readonly baseUrl = process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1';
  private readonly model = process.env.XAI_MODEL ?? 'grok-4-1-fast';
  private cache: Map<string, { result: TokenXSentiment; expiry: number }>;
  private readonly CACHE_TTL = parseInt(process.env.GROK_TOKEN_CACHE_TTL_MS ?? '900000'); // 15min
  private stats = { calls: 0, cached: 0, errors: 0, totalLatencyMs: 0 };

  async analyzeToken(ticker: string, mintAddress: string): Promise<TokenXSentiment | null>

    Si pas de apiKey → return null (silencieux, ne JAMAIS crasher)
    Si en cache et pas expiré → return cached (stats.cached++)

    const t0 = performance.now();
    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          tools: [{ type: 'x_search' }],
          input: [
            {
              role: 'system',
              content: 'You are a crypto social media analyst. Analyze X/Twitter activity for the given Solana memecoin. Focus on: mention velocity (growing/stable/dying), organic vs bot hype, influencer involvement, narrative strength. Be skeptical of coordinated shilling. Return ONLY the JSON object requested.',
            },
            {
              role: 'user',
              content: `Analyze current X/Twitter buzz for Solana token $${ticker} (address: ${mintAddress.slice(0, 16)}…) in the last 30 minutes. Return ONLY JSON: {"mentionCount":0,"sentiment":0,"hypeLevel":0,"botActivity":0,"influencerMentions":0,"keyThemes":[],"confidence":0}`,
            },
          ],
          max_turns: 2,  // cap tool invocations pour contrôler les coûts
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) { stats.errors++; return null; }
      const data = await response.json();

      // Parser : data.output[] contient des blocks de type 'message'
      // Le texte JSON est dans output[last].content[0].text (ou similaire)
      // Chercher le premier bloc de texte qui contient du JSON valide
      let jsonText = '';
      for (const block of (data.output ?? data.content ?? [])) {
        const text = block?.content?.[0]?.text ?? block?.text ?? '';
        const match = text.match(/\{[^{}]*"mentionCount"[^{}]*\}/);
        if (match) { jsonText = match[0]; break; }
      }

      if (!jsonText) { stats.errors++; return null; }
      const parsed = JSON.parse(jsonText);

      const result: TokenXSentiment = {
        mentionCount: Math.max(0, Number(parsed.mentionCount) || 0),
        sentiment: Math.max(-1, Math.min(1, Number(parsed.sentiment) || 0)),
        hypeLevel: Math.max(0, Math.min(10, Number(parsed.hypeLevel) || 0)),
        botActivity: Math.max(0, Math.min(1, Number(parsed.botActivity) || 0)),
        influencerMentions: Math.max(0, Number(parsed.influencerMentions) || 0),
        keyThemes: Array.isArray(parsed.keyThemes) ? parsed.keyThemes.slice(0, 3) : [],
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
        fromCache: false,
        latencyMs: performance.now() - t0,
      };

      this.cache.set(mintAddress, { result, expiry: Date.now() + this.CACHE_TTL });
      this.stats.calls++;
      this.stats.totalLatencyMs += result.latencyMs;

      console.log(
        `🔍 [GrokX] $${ticker} | hype=${result.hypeLevel}/10 sent=${result.sentiment.toFixed(2)} ` +
        `mentions=${result.mentionCount} bot=${(result.botActivity*100).toFixed(0)}% | ${result.latencyMs.toFixed(0)}ms`,
      );

      return result;
    } catch {
      this.stats.errors++;
      return null;
    }

  getStats() → { calls, cached, errors, avgLatencyMs }

  // Cleanup du cache (appelé périodiquement)
  pruneCache(): void → supprimer les entrées expirées

Export singleton : getGrokXScanner()

═══ FICHIER 2 : src/social/NarrativeRadar.ts ═══

Le radar qui détecte les narratifs émergents sur X AVANT qu'un token soit créé.
Tourne en background toutes les 2 minutes.

Classe NarrativeRadar extends EventEmitter :

  private readonly grok: GrokXScanner (ou appel direct fetch)
  private interval: ReturnType<typeof setInterval> | null
  private readonly SCAN_MS = parseInt(process.env.NARRATIVE_SCAN_INTERVAL_MS ?? '120000');
  private activeNarratives: Map<string, NarrativeSignal>; // theme → signal
  private readonly MAX_NARRATIVES = 50;

  Interface NarrativeSignal {
    theme: string;              // "pepe", "trump", "dogs"
    velocity: number;           // 1-10
    keywords: string[];         // mots-clés à matcher
    tickers: string[];          // $PEPE etc
    contractAddresses: string[];// si trouvées
    confidence: number;
    detectedAt: number;
  }

  async start(): void
    - Si pas de XAI_API_KEY → logger "⚠️ NarrativeRadar disabled (no XAI_API_KEY)" et return
    - Lancer immédiatement un scan
    - Puis toutes les SCAN_MS (2 min)
    - Logger "🔍 [NarrativeRadar] Started — scanning X trends every ${SCAN_MS/1000}s"

  private async scanTrends(): Promise<void>
    - POST au même endpoint que GrokXScanner mais avec un prompt différent :

    {
      model: this.model,
      tools: [{ type: 'x_search' }],
      input: [
        { role: 'system', content: 'You are a real-time crypto trend detector. Identify EMERGING narratives and viral moments on X related to Solana memecoins. Focus on: new meme trends, influencer pumps, Elon Musk mentions, breaking news that spawns tokens. Only report trends from the LAST 30 MINUTES. Return ONLY the JSON array.' },
        { role: 'user', content: 'What Solana memecoins, crypto memes, or narratives are suddenly trending or going viral on X RIGHT NOW in the last 30 minutes? Return ONLY JSON array: [{"theme":"...","velocity":1,"keywords":["..."],"tickers":["$..."],"contractAddresses":["..."],"confidence":0}]' }
      ],
      max_turns: 3,
    }

    - Parser le JSON array de la réponse
    - Pour chaque narratif avec velocity >= 5 :
      → Stocker dans activeNarratives (clé = theme.toLowerCase())
      → Émettre 'narrativeDetected' avec le signal
      → Logger "📢 [NarrativeRadar] 🔥 {theme} velocity={velocity} keywords={keywords.join(',')}"
    - Nettoyer les narratifs > 30 min (ils ne sont plus "émergents")

  matchesToken(name: string, symbol: string): NarrativeSignal | null
    → Pour chaque narratif actif :
      → Si name.toLowerCase() contient un des keywords OU
         symbol.toUpperCase() est dans tickers
      → Return le signal (le premier match)
    → Return null si aucun match

  getActiveNarratives(): NarrativeSignal[]
  async stop(): void → clearInterval

Export singleton : getNarrativeRadar()

═══ FICHIER 3 : src/social/SentimentAggregator.ts ═══

Fusionne les 3 sources sociales en un score unifié 0-1 pour le GraduationPredictor.

Classe SentimentAggregator :

  private readonly W_X = 0.50;         // Grok X Search (le plus puissant)
  private readonly W_TG = 0.30;        // Telegram activity
  private readonly W_DEX = 0.20;       // DexScreener boosts
  private tokenScores: Map<string, SocialComposite>;  // mint → score

  computeComposite(
    mint: string,
    xSentiment: TokenXSentiment | null,
    telegramScore: number,            // 0-1 du TelegramPulse/ViralityScorer
    dexBoostActive: boolean,
  ): number  // 0-1

    let score = 0;
    let weightSum = 0;

    if (xSentiment && xSentiment.confidence > 0.3) {
      // hypeLevel 0-10 → 0-1, pondéré par confidence et anti-bot
      const xScore = (xSentiment.hypeLevel / 10) * xSentiment.confidence * (1 - xSentiment.botActivity);
      score += this.W_X * xScore;
      weightSum += this.W_X;
    }

    if (telegramScore > 0) {
      score += this.W_TG * telegramScore;
      weightSum += this.W_TG;
    }

    if (dexBoostActive) {
      score += this.W_DEX * 0.7;  // boost = signal positif modéré
      weightSum += this.W_DEX;
    }

    // Normaliser par les poids disponibles (si pas de X data, redistribuer)
    const composite = weightSum > 0 ? score / weightSum : 0;

    this.tokenScores.set(mint, { score: composite, updatedAt: Date.now() });
    return composite;

  getScore(mint: string): number → return cached score ou 0

Export singleton : getSentimentAggregator()

═══ INTÉGRATION DANS app.ts ═══

Ajouter dans les imports :
  import { getGrokXScanner } from './social/GrokXScanner.js';
  import { getNarrativeRadar } from './social/NarrativeRadar.js';
  import { getSentimentAggregator } from './social/SentimentAggregator.js';

Ajouter au démarrage (après CurveTracker.start()) :
  // Grok Narrative Radar (background, non-bloquant)
  getNarrativeRadar().start().catch(() => {});

Ajouter dans le handler enterHotZone (AVANT la décision d'entrée) :
  // Grok X Search — analyse sociale asynchrone
  // Non bloquant : on lance et on utilise si dispo, sinon socialScore = 0
  const metadata = curve.metadata;
  const ticker = metadata?.symbol ?? 'UNKNOWN';
  const xSentiment = await getGrokXScanner().analyzeToken(ticker, mint).catch(() => null);

  // Narrative match — booster si le token correspond à une trend détectée
  const narrativeMatch = getNarrativeRadar().matchesToken(
    metadata?.name ?? '', ticker
  );

  // Agréger les scores sociaux
  const viralityScore = getViralityScorer().compute(mint)?.viralityScore ?? 0;
  const socialScore = getSentimentAggregator().computeComposite(
    mint, xSentiment, viralityScore, false  // dexBoostActive viendra du SocialTrendScanner
  );

  // Si narrative match → boost majeur
  let effectiveSocialScore = socialScore;
  if (narrativeMatch && narrativeMatch.velocity >= 7) {
    effectiveSocialScore = Math.min(1, socialScore + 0.3);
    console.log(`📢 [Narrative] ${mint.slice(0,8)} matches trend "${narrativeMatch.theme}" v=${narrativeMatch.velocity} → social boosted`);
  }

Modifier l'appel à AIBrain.decideCurve() pour passer le socialScore :
  const decision = brain.decideCurve(curve, trades, effectiveSocialScore);
  // Le 3ème argument est déjà `socialScore` dans la signature existante

═══ INTÉGRATION DANS GraduationPredictor ═══

Le socialScore est DÉJÀ passé en 3ème argument de predict().
Il est utilisé dans le scoring pondéré avec W_SOCIAL = 0.10.

Modification : Si le socialScore est > 0 (c'est-à-dire qu'on a des données Grok) :
  → Augmenter W_SOCIAL de 0.10 à 0.15 (confiance accrue car données réelles)
  → Réduire W_PROGRESS de 0.05 à 0.00 (le social remplace le prior bayésien)

Ce changement est conditionnel : seulement si socialScore > 0.
Si socialScore = 0 (pas de XAI_API_KEY ou erreur), garder les poids originaux.

═══ VARIABLES D'ENVIRONNEMENT ═══

XAI_API_KEY=                        # Obtenir sur console.x.ai ($25 signup + $150/mois data sharing)
XAI_BASE_URL=https://api.x.ai/v1
XAI_MODEL=grok-4-1-fast
GROK_TOKEN_CACHE_TTL_MS=900000      # 15 minutes
NARRATIVE_SCAN_INTERVAL_MS=120000   # 2 minutes

═══ RÈGLES STRICTES ═══

- Si XAI_API_KEY est vide → TOUT le module social est désactivé silencieusement
  (log un warning au démarrage, puis plus rien). Le bot marche parfaitement sans.
- JAMAIS d'await bloquant sur le hot path pour Grok (2-10s de latence).
  L'appel Grok doit être en background ou avec un timeout de 15s.
- JAMAIS envoyer de private keys, wallet addresses, ou positions dans les prompts Grok.
  Seuls le ticker et le mint address (public) sont envoyés.
- try/catch PARTOUT. Une erreur Grok ne doit JAMAIS crasher le bot.
- TypeScript strict, Bun only, imports avec .js extension.
```

---

## IMPLÉMENTATION 2 : TELEGRAM FONCTIONNEL

### Prompt Cursor Composer 2

```
@codebase
@file src/ingestors/TelegramPulse.ts (MODIFIER)
@file src/ingestors/TelegramTokenScanner.ts (NOUVEAU — créer)
@file src/social/SentimentAggregator.ts (référence)
@file src/nlp/NLPPipeline.ts (référence — process())
@file src/nlp/ViralityScorer.ts (référence — addMention())
@file src/app.ts (MODIFIER — wiring)

═══ PARTIE 1 : VÉRIFIER ET FIXER TelegramPulse ═══

TelegramPulse existe dans le codebase mais est marqué "❌ Inactif" dans le dashboard.
Il utilise GramJS (package `telegram`) pour se connecter aux channels Telegram.

Vérifier que TelegramPulse fonctionne quand les credentials sont fournis :
- TELEGRAM_API_ID (integer) et TELEGRAM_API_HASH (string) requis
- TELEGRAM_SESSION_STRING optionnel (sauvé après première auth)
- La première connexion demande le numéro de téléphone et un code SMS
  → C'est attendu. L'utilisateur entrera ses credentials une fois.
  → La session est sauvée pour ne pas redemander.

Dans app.ts, vérifier que TelegramPulse.start() est appelé ET que
ses événements 'newSignal' sont wirés au pipeline NLP :

  this.telegramPulse.on('newSignal', (signal) => {
    // Passer le message au NLPPipeline pour scoring sentiment
    getNLPPipeline().process(
      signal.rawText ?? `Token mention: ${signal.mint}`,
      signal.mint,
      'Telegram',
      50,  // authorTrust par défaut
      100, // reach par défaut
    ).catch(() => {});

    // Alimenter le ViralityScorer
    getViralityScorer().addMention({
      mint: signal.mint,
      platform: 'Telegram',
      authorTrustScore: 50,
      reach: 100,
      sentiment: signal.score > 0 ? 0.5 : -0.5,
      timestamp: Date.now(),
    });
  });

═══ PARTIE 2 : TelegramTokenScanner (NOUVEAU) ═══

Fichier : src/ingestors/TelegramTokenScanner.ts

Quand un token entre en HOT zone, ce scanner cherche automatiquement
le canal Telegram du token et analyse le sentiment.

Classe TelegramTokenScanner :

  private analyzedMints: Map<string, TokenSocialScore>;  // cache, TTL 15min
  private pendingAnalyses: Set<string>;                   // anti-duplication
  private readonly MAX_CONCURRENT = 3;                    // max analyses simultanées

  async analyzeTokenSocial(mint: string): Promise<TokenSocialScore>

    Si déjà en cache et pas expiré → return cached
    Si déjà en cours d'analyse → return score neutre (0.5)

    1. Découvrir le lien Telegram du token :
       a) DexScreener API (gratuit, priorité) :
          GET https://api.dexscreener.com/latest/dex/tokens/${mint}
          → data.pairs?.[0]?.info?.socials → chercher type 'telegram'
          → Timeout 3s, try/catch silencieux
       b) Si pas trouvé → return score neutre

    2. Si lien trouvé, analyser le canal :
       → Si TelegramPulse est actif ET a un client GramJS connecté :
         → Utiliser client.getMessages(channel, { limit: 30 })
         → Compter messages des 5 dernières minutes → messagesPerMinute
         → Scanner les red flags dans les messages : "rug", "scam", "sell", "dump", "fake"
         → Calculer sentiment moyen via NLPPipeline (batch les 10 derniers messages)
       → Si TelegramPulse inactif :
         → Estimer depuis DexScreener (pair.txns.h1 = volume activité)
         → Score approximatif basé sur le volume seul

    3. Calculer TokenSocialScore :
       → compositeScore = engagement * sentiment_factor * anti_red_flag
       → engagement = min(1, messagesPerMinute / 10)
       → sentiment_factor = (avgSentiment + 1) / 2  (normalize 0-1)
       → anti_red_flag = redFlagCount >= 3 ? 0 : 1 - (redFlagCount * 0.2)

    4. Stocker en cache, return

  Interface TokenSocialScore {
    mint: string;
    telegramUrl: string | null;
    messagesPerMinute: number;
    avgSentiment: number;          // -1 à 1
    memberCount: number;
    redFlagCount: number;
    compositeScore: number;        // 0-1
    source: 'telegram_live' | 'dexscreener_estimate' | 'none';
    analyzedAt: number;
  }

Export singleton : getTelegramTokenScanner()

═══ INTÉGRATION DANS app.ts ═══

Dans le handler enterHotZone, APRÈS le Grok scan et AVANT la décision :
  
  const tgScore = await getTelegramTokenScanner()
    .analyzeTokenSocial(mint)
    .catch(() => ({ compositeScore: 0 } as TokenSocialScore));

  // Le SentimentAggregator fusionne X + TG + DEX
  const socialScore = getSentimentAggregator().computeComposite(
    mint, xSentiment, tgScore.compositeScore, false
  );

═══ VARIABLES D'ENVIRONNEMENT ═══

TELEGRAM_API_ID=                    # Integer, obtenir sur my.telegram.org
TELEGRAM_API_HASH=                  # String, obtenir sur my.telegram.org  
TELEGRAM_SESSION_STRING=            # Sauvé après première connexion

═══ COMPORTEMENT SANS CREDENTIALS ═══

Si TELEGRAM_API_ID ou TELEGRAM_API_HASH manquent :
  → TelegramPulse ne démarre pas (déjà le cas)
  → TelegramTokenScanner utilise DexScreener comme fallback
  → Logger au boot : "⚠️ TelegramPulse disabled (no TELEGRAM_API_ID)"
  → Le bot marche parfaitement, juste sans signal TG
```

---

## IMPLÉMENTATION 3 : DEXSCREENER SOCIAL BOOST

### Prompt Cursor Composer 2

```
@codebase
@file src/ingestors/SocialTrendScanner.ts (NOUVEAU — créer)
@file src/modules/curve-tracker/CurveTracker.ts (référence — forcePromoteHot)
@file src/social/SentimentAggregator.ts (référence)
@file src/app.ts (MODIFIER — wiring)

Classe SocialTrendScanner extends EventEmitter :

  private boostInterval: ReturnType<typeof setInterval> | null = null;
  private knownBoosts: Set<string> = new Set();
  private boostedMints: Set<string> = new Set();  // mints avec boost actif
  private readonly POLL_MS = 30_000;  // 30s

  async start(): void
    → setInterval(pollBoosts, POLL_MS)
    → Premier poll immédiat
    → Logger "🔍 [SocialTrend] Started — DexScreener boosts every 30s"

  private async pollBoosts(): void
    try {
      const resp = await fetch('https://api.dexscreener.com/token-boosts/latest/v1', {
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) return;
      const data = await resp.json() as Array<{ tokenAddress: string; chainId: string; amount?: number }>;

      for (const item of data) {
        if (item.chainId !== 'solana') continue;
        if (this.knownBoosts.has(item.tokenAddress)) continue;
        
        this.knownBoosts.add(item.tokenAddress);
        this.boostedMints.add(item.tokenAddress);
        this.emit('socialBoost', {
          mint: item.tokenAddress,
          source: 'dexscreener_boost',
          boostAmount: item.amount ?? 0,
        });
        
        console.log(`📢 [DexScreener] Boost detected: ${item.tokenAddress.slice(0,8)}…`);
      }

      // LRU eviction du cache
      if (this.knownBoosts.size > 10_000) {
        const arr = Array.from(this.knownBoosts);
        arr.splice(0, 5_000);
        this.knownBoosts = new Set(arr);
      }
    } catch { /* silent */ }

  isBoosted(mint: string): boolean
    → return this.boostedMints.has(mint);

  async stop(): void
    → clearInterval

Export singleton : getSocialTrendScanner()

═══ INTÉGRATION app.ts ═══

Au démarrage :
  const socialTrend = getSocialTrendScanner();
  await socialTrend.start();

  socialTrend.on('socialBoost', ({ mint }) => {
    const ct = getCurveTracker();
    const existing = ct.getCurveState(mint);
    if (existing && existing.tier !== 'hot') {
      ct.forcePromoteHot(mint);
    }
  });

Dans le handler enterHotZone, le isBoosted alimente le SentimentAggregator :
  const dexBoosted = getSocialTrendScanner().isBoosted(mint);
  const socialScore = getSentimentAggregator().computeComposite(
    mint, xSentiment, tgScore.compositeScore, dexBoosted
  );
```

---

## IMPLÉMENTATION 4 : WHALE WALLET DB + BOOTSTRAP

### Prompt Cursor Composer 2

```
@codebase
@file src/data/WhaleWalletDB.ts (NOUVEAU — créer)
@file src/data/FeatureStore.ts (MODIFIER — ajouter table whale_wallets)
@file src/ingestors/SmartMoneyTracker.ts (référence — addWallets)
@file src/modules/graduation-predictor/WalletScorer.ts (référence — setSmartMoneyList)
@file scripts/seed-whales.ts (NOUVEAU — créer)
@file src/app.ts (MODIFIER — charger whales au boot)

═══ SCHÉMA SQLite (dans FeatureStore.initSchema) ═══

CREATE TABLE IF NOT EXISTS whale_wallets (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT 'unknown',
  trust_score REAL NOT NULL DEFAULT 0.5,
  tokens_bought INTEGER NOT NULL DEFAULT 0,
  tokens_graduated INTEGER NOT NULL DEFAULT 0,
  win_rate REAL NOT NULL DEFAULT 0,
  last_seen_ms INTEGER NOT NULL DEFAULT 0,
  discovered_via TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

═══ Classe WhaleWalletDB ═══

  constructor(db: Database)  // le même bun:sqlite que FeatureStore

  addWhale(address, label, discoveredVia): void
    → INSERT OR IGNORE avec created_at = Date.now()

  updateStats(address, graduated: boolean): void
    → tokens_bought += 1
    → Si graduated : tokens_graduated += 1
    → win_rate = tokens_graduated / tokens_bought
    → updated_at = Date.now()

  getTopWhales(limit = 100): WhaleWallet[]
    → SELECT ORDER BY trust_score DESC LIMIT ?

  isWhale(address): boolean
    → SELECT 1 FROM whale_wallets WHERE address = ? LIMIT 1

  getWhaleCount(): number

  loadIntoSmartMoneyTracker(): void
    → Charger top 100 whales
    → Convertir en WalletProfile[] pour SmartMoneyTracker
    → Appeler getSmartMoneyTracker().addWallets(profiles)
    → Logger "🐋 [WhaleDB] Loaded {N} whales into SmartMoneyTracker"

Export singleton : getWhaleWalletDB()

═══ Script scripts/seed-whales.ts ═══

Script de bootstrap initial avec des wallets connus.
Exécuter manuellement une fois : bun scripts/seed-whales.ts

const KNOWN_WHALES = [
  // Ajouter ici des wallets de smart money connus
  // Format : { address, label, trust_score }
  // Ces wallets seront enrichis au fur et à mesure que le bot collecte des outcomes
];

// Insérer dans la DB
const db = getWhaleWalletDB();
for (const w of KNOWN_WHALES) {
  db.addWhale(w.address, w.label, 'manual_seed');
}
console.log(`🐋 Seeded ${KNOWN_WHALES.length} whales`);

═══ INTÉGRATION app.ts ═══

Au boot, APRÈS FeatureStore init :
  getWhaleWalletDB().loadIntoSmartMoneyTracker();

Quand labelCurveOutcome est appelé (graduated ou evicted) :
  // Enrichir la whale DB avec les outcomes
  const trades = curveTracker.getTradeHistory(mint);
  const earlyBuyers = trades
    .filter(t => t.isBuy)
    .map(t => t.trader);
  for (const buyer of new Set(earlyBuyers)) {
    getWhaleWalletDB().updateStats(buyer, graduated);
  }
```

---

## IMPLÉMENTATION 5 : DURCISSEMENT STRATÉGIE QUANT (APEX_QUANT_STRATEGY.md)

### Prompt Cursor Composer 2

```
@codebase
@file src/modules/graduation-predictor/GraduationPredictor.ts (MODIFIER)
@file src/modules/position/ExitEngine.ts (MODIFIER)
@file src/modules/entry/EntryFilter.ts (MODIFIER)
@file APEX_QUANT_STRATEGY.md (référence — Sections 5, 6, 7, 8)

═══ A) SCORING PONDÉRÉ — aligner sur APEX_QUANT_STRATEGY §5 ═══

Dans GraduationPredictor, le scoring pondéré doit utiliser les poids exacts :

  Trading Intensity  : 0.35  (avgSolPerTrade / 1.0, cap à 1)
  Velocity Momentum  : 0.20  (solPerMin_1m / 3.0 × velocityRatio)
  Anti-Bot Score     : 0.15  (1 - botTransactionRatio)
  Holder Quality     : 0.10  ((1 - freshWalletRatio) × (1 - top10Concentration/100))
  Smart Money        : 0.08  (smartMoneyBuyerCount / 3, cap à 1)
  Social Signal      : 0.07  (socialScore du SentimentAggregator, 0-1)
  Progress Sigmoid   : 0.05  (1 / (1 + exp(-12 × (progress - 0.55))))

VÉRIFIER que les poids actuels dans le code matchent. Si non → corriger.

═══ B) SAFETY MARGIN DYNAMIQUE — §6 ═══

Remplacer le safety_margin fixe par la formule dynamique :

  safety_margin = 1 + (1 - confidence) × 0.8

Où confidence vient du GraduationPredictor (0.15 pour heuristique, 0.3-0.8 pour scoring pondéré).
Cela donne ~1.68 pour l'heuristique (très sélectif) et ~1.16 pour un bon signal (plus permissif).

═══ C) VÉTOS V1-V5 — §5 ═══

Vérifier que les 5 vétos sont actifs dans GraduationPredictor.predict() :
  V1: creatorIsSelling → SKIP
  V2: botRatio > 0.70 → SKIP
  V3: tradingIntensity < 0.15 SOL/trade → SKIP
  V4: progress < 0.45 ou > 0.85 → SKIP
  V5: ageMinutes > 45 et progress < 0.60 → SKIP

═══ D) EXIT — §8 ═══

Vérifier que l'ExitEngine utilise les seuils de la stratégie quant :
  - TIME_STOP = 10 minutes (600s) si pGrad < 50%
  - STALL = velocity < 0.1 SOL/min pendant 2 minutes (120s)
  - Ajouter : PROGRESS_REGRESSION — si currentProgress < entryProgress - 0.10 → SELL

═══ E) KELLY — §7 ═══

Vérifier que le Kelly dans AIBrain.decideCurve() utilise :
  f* = (b × p - q) / b   avec b = M(realSol) - 1
  position = min(f*/4 × bankroll, MAX_POSITION_SOL, bankroll × MAX_POSITION_PCT)

Où M(realSol) = (115 / (30 + realSol))² est le multiple à graduation.
```

---

## IMPLÉMENTATION 6 : PIPELINE DONNÉES QUALITÉ POUR ML

### Prompt Cursor Composer 2

```
@codebase
@file src/data/FeatureStore.ts (MODIFIER)
@file src/app.ts (MODIFIER)
@file src/modules/curve-tracker/TieredMonitor.ts (MODIFIER)

═══ A) FIXER LES OUTCOMES À 0 ═══

Le dashboard montre 80 evictions mais 0 outcomes.
Le handler evicted dans app.ts doit appeler labelCurveOutcome.

Vérifier dans app.ts que ce code existe ET fonctionne :

  curveTracker.on('evicted', (mint: string, reason: string) => {
    try {
      // IMPORTANT : récupérer le curve state AVANT l'eviction
      // car après, getCurveState(mint) retourne null
      const curve = curveTracker.getCurveState(mint);
      if (curve) {
        getFeatureStore().labelCurveOutcome({
          mint,
          graduated: false,
          finalProgress: curve.progress,
          finalSol: curve.realSolSOL,
          durationS: (Date.now() - curve.createdAt) / 1000,
          evictionReason: reason,
        });
      }
    } catch { /* cold path */ }
  });

PROBLÈME POTENTIEL : L'event 'evicted' est émis APRÈS que le mint
est supprimé des maps. Il faut que TieredMonitor émette l'event
AVANT de supprimer le mint, ou passe le curve state dans l'event.

FIX dans TieredMonitor : modifier la méthode evict() :
  private evict(mint: string, reason: string): void {
    const curve = this.getCurve(mint);  // AVANT suppression
    this.cold.delete(mint);
    this.warm.delete(mint);
    this.hot.delete(mint);
    this.batchPoller.unregister(mint);
    this.emit('evicted', mint, reason, curve);  // passer le curve
  }

Et dans app.ts, adapter le handler :
  curveTracker.on('evicted', (mint, reason, curve) => { ... });

═══ B) SNAPSHOTS QUI CONTINUENT DE S'INCRÉMENTER ═══

Les snapshots sont figés à 25204. Vérifier que appendCurveSnapshot()
est appelé dans le handler curveUpdate pour TOUTES les curves HOT,
pas seulement celles avec position ouverte.

Vérifier dans app.ts ou DecisionCore que ce code existe :
  if (curve.tier === 'hot') {
    // Logger le snapshot AVANT toute évaluation d'entrée ou de sortie
    getFeatureStore().appendCurveSnapshot({ ... });
  }

Si les snapshots ne sont loggés QUE lors des évaluations du predictor
(qui sont throttlées par le cooldown), il manque des snapshots pour
les curves non-évaluées. Il faut logger à chaque curveUpdate HOT.

═══ C) ENRICHIR LES SNAPSHOTS AVEC LE SOCIAL SCORE ═══

Ajouter dans curve_snapshots une colonne social_score :
  ALTER TABLE curve_snapshots ADD COLUMN social_score REAL DEFAULT 0;

Quand appendCurveSnapshot est appelé, inclure :
  social_score = getSentimentAggregator().getScore(mint)

Cela enrichit le dataset ML avec la dimension sociale.
```

---

## RÉSUMÉ — ORDRE D'EXÉCUTION DANS CURSOR

```
SESSION 1 (2h) : Grok X Search + NarrativeRadar + SentimentAggregator
  → Prompt #1
  → Créer 3 fichiers, wirer dans app.ts
  → Test : vérifier les logs 🔍 [GrokX] et 📢 [NarrativeRadar]
  → Configurer XAI_API_KEY dans .env

SESSION 2 (1h30) : Telegram fonctionnel + TelegramTokenScanner
  → Prompt #2
  → Fixer TelegramPulse + créer TelegramTokenScanner
  → Test : configurer TELEGRAM_API_ID/HASH, vérifier la connexion
  → Si pas de credentials TG → skip, le bot marche sans

SESSION 3 (45min) : DexScreener Social Boost
  → Prompt #3
  → Créer SocialTrendScanner
  → Test : vérifier les logs 📢 [DexScreener] Boost detected

SESSION 4 (1h) : WhaleWalletDB
  → Prompt #4
  → Créer WhaleWalletDB + scripts/seed-whales.ts
  → Exécuter : bun scripts/seed-whales.ts

SESSION 5 (1h) : Stratégie Quant alignée
  → Prompt #5
  → Vérifier/corriger les poids, safety margin, vétos, Kelly
  → C'est principalement de la vérification, pas de nouveau code

SESSION 6 (30min) : Fix pipeline données
  → Prompt #6
  → Fixer outcomes + snapshots + social_score column
  → Test : relancer 30min → vérifier Outcomes > 0

═══ APRÈS TOUTES LES SESSIONS ═══

Lancer le bot 24-48h en continu pour collecter :
  ✓ Outcomes (graduated/evicted) — objectif 500+
  ✓ Snapshots enrichis (social score, velocity, bot ratio)
  ✓ Paper trades avec P&L réaliste
  ✓ paper_trades.jsonl pour audit

Puis : python/train_graduation_model.py (LightGBM)
  → Entraîner sur curve_snapshots + curve_outcomes
  → Export ONNX → hot-swap via ModelUpdater
  → Le modèle ML remplace l'heuristique
```

---

## VARIABLES D'ENVIRONNEMENT COMPLÈTES (.env)

```env
# ═══ Core ═══
STRATEGY_MODE=curve-prediction
TRADING_MODE=paper
PAPER_BANKROLL_SOL=2.0

# ═══ RPC ═══
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=XXX
RPC_URL=https://mainnet.helius-rpc.com/?api-key=XXX
QUICKNODE_RPC_URL=https://xxx

# ═══ Wallet ═══
WALLET_PRIVATE_KEY=xxx

# ═══ Grok (X Search) ═══
XAI_API_KEY=xxx
XAI_BASE_URL=https://api.x.ai/v1
XAI_MODEL=grok-4-1-fast
NARRATIVE_SCAN_INTERVAL_MS=120000
GROK_TOKEN_CACHE_TTL_MS=900000

# ═══ Groq (NLP) ═══
GROQ_API_KEY=xxx

# ═══ Telegram ═══
TELEGRAM_API_ID=xxx
TELEGRAM_API_HASH=xxx
TELEGRAM_SESSION_STRING=

# ═══ Entrée (Stratégie Quant §5-6) ═══
CURVE_ENTRY_MIN_PROGRESS=0.45
CURVE_ENTRY_MAX_PROGRESS=0.85
MIN_TRADING_INTENSITY=0.15
MIN_TRADE_COUNT=5
MIN_VELOCITY_SOL_MIN=0.5

# ═══ Sortie (§8) ═══
STOP_LOSS_PCT=0.15
TRAILING_STOP_PCT=0.20
TAKE_PROFIT_PCT=0.50
TIME_STOP_SECONDS=600
TIME_STOP_MIN_PGRAD=0.50
STALL_VELOCITY_THRESHOLD=0.10
STALL_SOL_FLOW_MIN=0.10
STALL_DURATION_SECONDS=120

# ═══ Graduation Exit ═══
GRAD_T1_PCT=0.40
GRAD_T2_PCT=0.35
GRAD_T2_DELAY_MS=60000
GRAD_T3_DELAY_MS=300000

# ═══ Risk ═══
MAX_CONCURRENT_CURVE_POSITIONS=5
KELLY_FRACTION=0.25
MAX_POSITION_PCT=0.10
MAX_POSITION_SOL=0.50
MIN_POSITION_SOL=0.03

# ═══ Persistance ═══
CURVE_POSITION_PERSIST=1
PAPER_TRADE_LOG=1
PAPER_TRADE_LOG_PATH=data/paper_trades.jsonl

# ═══ Jito ═══
JITO_BLOCK_ENGINE_URL=https://amsterdam.mainnet.block-engine.jito.wtf
JITO_TIP_LAMPORTS=50000
```




# APEX-2026 — DIRECTIVE CURSOR : ROTATION AGRESSIVE + SOCIAL + DATA QUALITY

**Date :** 23 mars 2026  
**Problème #1 :** Les positions stagnantes bloquent les 5 slots = opportunités manquées  
**Problème #2 :** Les fichiers de données SQLite sont illisibles (c'est normal — format binaire)  
**Objectif :** Bot rapide qui coupe vite, libère les slots, collecte des données exploitables

**Référence quant unique :** paramètres chiffrés (sorties, poids §5, env §12) = **`APEX_QUANT_STRATEGY.md`** — notamment **Section 0** (profil **Rotation** vs option Conservation ; poids sociaux fixes vs signal dynamique). Ce fichier applique PROMPT 0–6 au code ; ne pas maintenir des valeurs concurrentes ailleurs sans mettre à jour APEX en premier.

---

## PROMPT 0 : FIX ROTATION AGRESSIVE DES POSITIONS (FAIRE EN PREMIER)

Ce prompt corrige LE problème principal que tu as vu : les positions stagnantes
qui bloquent les 5 slots pendant des heures.

```
@codebase
@file src/modules/position/ExitEngine.ts
@file src/modules/graduation-predictor/GraduationPredictor.ts
@file src/app.ts
@file APEX_QUANT_STRATEGY.md

Le bot garde les positions trop longtemps. Les 5 slots sont bloqués par des
tokens stagnants et on loupe des opportunités. Il y a 3 causes root :

═══ CAUSE 1 : Le stall detection exige `hasMicro` ═══

Dans ExitEngine.evaluate(), le stall check est conditionné par :
  const hasMicro = velocity.tradesToReachCurrentLevel > 0 || velocity.peakVelocity_5m > 1e-6;
  
Si ces valeurs ne sont pas alimentées (ce qui arrive souvent en early hot),
le stall NE FIRE JAMAIS. Les positions stagnent indéfiniment.

FIX : Retirer la condition hasMicro pour le stall. Le stall doit se baser
sur la RÉALITÉ observable : si solPerMinute_1m < seuil pendant > durée,
c'est un stall QUEL QUE SOIT l'état de hasMicro.

Remplacer :
  if (hasMicro && velocity.velocityRatio < this.stallVelocityThreshold && velocity.solPerMinute_1m < this.stallSolFlowMin) {

Par :
  if (velocity.solPerMinute_1m < this.stallSolFlowMin) {

Le stall est maintenant déclenché uniquement sur le flux SOL réel, pas sur
des métriques dérivées qui peuvent être 0.

═══ CAUSE 2 : Le time stop est bypassé par livePGrad ═══

Le time stop a un bypass :
  if (live !== undefined && live >= this.timeStopMinPGrad) { /* HOLD */ }

Le problème : le fallback heuristique du GraduationPredictor retourne
TOUJOURS un pGrad > 0.5 pour les curves > 50% progress. Donc le time
stop ne fire JAMAIS pour ces curves.

FIX : Ajouter un HARD TIME STOP qui ne peut PAS être bypassé.
Après le time stop actuel, ajouter :

  // HARD TIME STOP : 5 minutes ABSOLU, pas de bypass possible
  const HARD_MAX_HOLD_MS = parseInt(process.env.HARD_MAX_HOLD_SECONDS ?? '300') * 1000;
  if (now - position.entryTimestamp > HARD_MAX_HOLD_MS) {
    this.stallLowSince.delete(mint);
    return this.sig(
      mint,
      'time_stop',
      'SELL_100PCT',
      'CRITICAL',
      `HARD time stop: held > ${HARD_MAX_HOLD_MS / 1000}s (NO bypass)`,
      pnlPct,
    );
  }

═══ CAUSE 3 : Pas de détection de régression du progress ═══

Les positions de ton run montraient des tokens qui RÉGRESSAIENT :
ECTT6XWA est passé de 55% à 24%, 4EhD291j de 21% à 13%.
Quand le progress BAISSE, les gens vendent = le token meurt.
Aucun code ne détecte ça.

FIX : Ajouter un check de régression APRÈS le stop loss et AVANT le trailing :

  // PROGRESS REGRESSION : si le progress a chuté de > 10% depuis l'entrée
  if (position.currentProgress < position.entryProgress - 0.10) {
    this.stallLowSince.delete(mint);
    return this.sig(
      mint,
      'progress_regression' as ExitReason,  // ajouter à ExitReason type
      'SELL_100PCT',
      'HIGH',
      `progress dropped ${(position.entryProgress * 100).toFixed(0)}% → ${(position.currentProgress * 100).toFixed(0)}%`,
      pnlPct,
    );
  }

Ajouter 'progress_regression' au type ExitReason :
  export type ExitReason = ... | 'progress_regression';

═══ RÉSUMÉ DES SEUILS OPTIMAUX (mettre dans .env) ═══

TIME_STOP_SECONDS=300          # 5 minutes (était 600 = trop long)
HARD_MAX_HOLD_SECONDS=300      # 5 min absolue, AUCUN bypass
STALL_DURATION_SECONDS=90      # 1.5 min (était 120 = trop long)
STALL_SOL_FLOW_MIN=0.05        # 0.05 SOL/min (était 0.1 = trop permissif)
STALL_VELOCITY_THRESHOLD=0.15  # (était 0.1)
EXIT_EVAL_COOLDOWN_MS=3000     # 3s (était 5s = trop lent)

═══ LOGIQUE COMPLÈTE DE evaluate() APRÈS FIX ═══

Ordre de priorité (le premier qui match gagne) :

1. GRADUATION (curve.complete || progress >= 0.99) → 3 tranches
2. STOP LOSS (pnlPct < -15%) → SELL 100% — NON NÉGOCIABLE
3. PROGRESS REGRESSION (currentProgress < entryProgress - 0.10) → SELL 100%
4. TRAILING STOP (peak > 10% profit, drawdown > 20%) → SELL 100%
5. VELOCITY COLLAPSE (velocity collapse sans hasMicro condition) → SELL 100%
6. STALL (solPerMinute < 0.05 pendant > 90s) → SELL 100%
7. TIME STOP (> 5 min ET pGrad < 0.5) → SELL 100%
8. HARD TIME STOP (> 5 min ABSOLU, AUCUN bypass) → SELL 100%
9. TAKE PROFIT (pnl > 50% ET velocity faiblit) → SELL 50%

AJOUTER au log de démarrage ExitEngine :
  hardMax=${HARD_MAX_HOLD_MS/1000}s (NO BYPASS)

TESTER : Relancer le bot 30 min. VÉRIFIER que :
  - Des positions se ferment en < 5 minutes si stagnantes
  - Le log montre 🚨 [ExitEngine] avec des raisons variées
  - Les 5 slots ne sont JAMAIS tous bloqués plus de 5 minutes
```

---

## PROMPT 1 : FIX DONNÉES — OUTCOMES + SNAPSHOTS + FORMAT EXPLOITABLE

```
@codebase
@file src/data/FeatureStore.ts
@file src/modules/curve-tracker/TieredMonitor.ts
@file src/app.ts
@file scripts/export-ml-dataset.ts (NOUVEAU — créer)

═══ A) FIXER LES OUTCOMES À 0 ═══

Le dashboard montre Outcomes: 0 malgré 80+ evictions. Le problème est que
l'event 'evicted' de TieredMonitor est émis APRÈS que le curve state est
supprimé des maps. Du coup quand app.ts essaie de récupérer le curve state
dans le handler, il obtient null.

FIX dans TieredMonitor — modifier la méthode evict() pour passer le state :

  private evict(mint: string, reason: string): void {
    // CAPTURER LE STATE AVANT LA SUPPRESSION
    const curveState = this.getCurve?.(mint) ?? this.hot.get(mint) ?? this.warm.get(mint) ?? this.cold.get(mint);
    const progress = curveState?.progress ?? 0;
    const realSol = curveState?.realSolSOL ?? 0;
    const createdAt = curveState?.createdAt ?? Date.now();
    
    this.cold.delete(mint);
    this.warm.delete(mint);
    this.hot.delete(mint);
    this.batchPoller?.unregister(mint);
    
    // Émettre AVEC les données du curve state
    this.emit('evicted', mint, reason, { progress, realSol, createdAt });
  }

FIX dans app.ts — le handler evicted doit logger l'outcome :

  curveTracker.on('evicted', (mint: string, reason: string, curveData?: { progress: number; realSol: number; createdAt: number }) => {
    try {
      const p = curveData?.progress ?? 0;
      const sol = curveData?.realSol ?? 0;
      const dur = curveData?.createdAt ? (Date.now() - curveData.createdAt) / 1000 : 0;
      getFeatureStore().labelCurveOutcome({
        mint,
        graduated: false,
        finalProgress: p,
        finalSol: sol,
        durationS: dur,
        evictionReason: reason,
      });
    } catch { /* cold path */ }
  });

Vérifier que labelCurveOutcome() INSERT bien dans la table curve_outcomes.
Si la méthode n'existe pas, créer :

  labelCurveOutcome(data: { mint: string; graduated: boolean; finalProgress: number; finalSol: number; durationS: number; evictionReason?: string }): void {
    this.db.run(
      `INSERT OR REPLACE INTO curve_outcomes (mint, graduated, final_progress, final_sol, duration_s, eviction_reason, timestamp_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.mint, data.graduated ? 1 : 0, data.finalProgress, data.finalSol, data.durationS, data.evictionReason ?? null, Date.now()]
    );
  }

═══ B) DÉBLOQUER LES SNAPSHOTS ═══

Le compteur de snapshots est figé à 25204. Vérifier que appendCurveSnapshot()
est appelé à chaque curveUpdate pour TOUTES les curves HOT, pas seulement
celles qui passent le predictor. Si le code conditionne les snapshots à une
évaluation du predictor (qui est throttlée par cooldown), ça explique pourquoi
les snapshots ne bougent plus.

Le snapshot doit être loggé à CHAQUE tick HOT, indépendamment du predictor.

═══ C) SCRIPT D'EXPORT LISIBLE : scripts/export-ml-dataset.ts ═══

Créer un script qui exporte les données SQLite en CSV lisible.
C'est la raison pour laquelle les fichiers de données paraissent "buggés"
quand tu les ouvres — la base SQLite est un fichier BINAIRE, pas du texte.
Il faut les exporter en CSV pour les lire ou les ouvrir dans Excel/Google Sheets.

Fichier : scripts/export-ml-dataset.ts

  import { Database } from 'bun:sqlite';

  const dbPath = process.argv[2] ?? 'data/apex.db';
  const db = new Database(dbPath, { readonly: true });

  // Export curve_snapshots
  const snapshots = db.query('SELECT * FROM curve_snapshots ORDER BY timestamp_ms DESC LIMIT 50000').all();
  if (snapshots.length > 0) {
    const headers = Object.keys(snapshots[0] as Record<string, unknown>).join(',');
    const rows = snapshots.map(r => Object.values(r as Record<string, unknown>).join(','));
    const csv = [headers, ...rows].join('\n');
    await Bun.write('data/curve_snapshots.csv', csv);
    console.log(`✅ Exported ${snapshots.length} snapshots → data/curve_snapshots.csv`);
  } else {
    console.log('⚠️ No snapshots found');
  }

  // Export curve_outcomes
  const outcomes = db.query('SELECT * FROM curve_outcomes ORDER BY timestamp_ms DESC').all();
  if (outcomes.length > 0) {
    const headers = Object.keys(outcomes[0] as Record<string, unknown>).join(',');
    const rows = outcomes.map(r => Object.values(r as Record<string, unknown>).join(','));
    const csv = [headers, ...rows].join('\n');
    await Bun.write('data/curve_outcomes.csv', csv);
    console.log(`✅ Exported ${outcomes.length} outcomes → data/curve_outcomes.csv`);
  } else {
    console.log('⚠️ No outcomes found');
  }

  // Export paper trades
  const trades = db.query(`SELECT * FROM open_curve_positions`).all();
  console.log(`📊 Open positions in DB: ${trades.length}`);

  // Export paper_trades.jsonl en CSV aussi
  try {
    const jsonl = await Bun.file('data/paper_trades.jsonl').text();
    const lines = jsonl.trim().split('\n').map(l => JSON.parse(l));
    if (lines.length > 0) {
      const headers = Object.keys(lines[0]).join(',');
      const rows = lines.map(l => Object.values(l).join(','));
      await Bun.write('data/paper_trades.csv', [headers, ...rows].join('\n'));
      console.log(`✅ Exported ${lines.length} paper trades → data/paper_trades.csv`);
    }
  } catch {
    console.log('⚠️ No paper_trades.jsonl found');
  }

  // Résumé
  console.log('\n📊 RÉSUMÉ BASE DE DONNÉES :');
  const snapshotCount = (db.query('SELECT COUNT(*) as c FROM curve_snapshots').get() as any)?.c ?? 0;
  const outcomeCount = (db.query('SELECT COUNT(*) as c FROM curve_outcomes').get() as any)?.c ?? 0;
  console.log(`   Snapshots: ${snapshotCount}`);
  console.log(`   Outcomes: ${outcomeCount}`);
  
  if (outcomeCount > 0) {
    const graduated = (db.query('SELECT COUNT(*) as c FROM curve_outcomes WHERE graduated = 1').get() as any)?.c ?? 0;
    const evicted = outcomeCount - graduated;
    console.log(`   Graduated: ${graduated} | Evicted: ${evicted}`);
    
    const reasons = db.query('SELECT eviction_reason, COUNT(*) as c FROM curve_outcomes GROUP BY eviction_reason ORDER BY c DESC').all();
    for (const r of reasons) {
      console.log(`     ${(r as any).eviction_reason}: ${(r as any).c}`);
    }
  }

  db.close();

Usage : bun scripts/export-ml-dataset.ts
Ouvre ensuite data/curve_snapshots.csv et data/curve_outcomes.csv
dans Excel, Google Sheets, ou n'importe quel éditeur de texte.
```

---

## PROMPT 2 : GROK X SEARCH + NARRATIVE RADAR

(Copier le contenu du Prompt #1 du document CURSOR_DIRECTIVE_FINAL.md déjà fourni)

---

## PROMPT 3 : TELEGRAM FONCTIONNEL

(Copier le contenu du Prompt #2 du document CURSOR_DIRECTIVE_FINAL.md déjà fourni)

---

## PROMPT 4 : DEXSCREENER BOOST

(Copier le contenu du Prompt #3 du document CURSOR_DIRECTIVE_FINAL.md déjà fourni)

---

## PROMPT 5 : WHALE WALLET DB

(Copier le contenu du Prompt #4 du document CURSOR_DIRECTIVE_FINAL.md déjà fourni)

---

## PROMPT 6 : ALIGNEMENT STRATÉGIE QUANT

(Copier le contenu du Prompt #5 du document CURSOR_DIRECTIVE_FINAL.md déjà fourni)

---

## .env OPTIMISÉ POUR ROTATION RAPIDE

```env
# ═══ SEUILS SORTIE AGRESSIFS ═══
TIME_STOP_SECONDS=300              # 5 minutes max (pas 10)
HARD_MAX_HOLD_SECONDS=300          # 5 min ABSOLU, AUCUN bypass possible
STALL_DURATION_SECONDS=90          # 1.5 min de stall → cut (pas 2 min)
STALL_SOL_FLOW_MIN=0.05            # Seuil plus sensible (pas 0.1)
STALL_VELOCITY_THRESHOLD=0.15      # Plus sensible (pas 0.1)
EXIT_EVAL_COOLDOWN_MS=3000         # Évaluer toutes les 3s (pas 5s)
STOP_LOSS_PCT=0.15
TRAILING_STOP_PCT=0.20
TAKE_PROFIT_PCT=0.50
TIME_STOP_MIN_PGRAD=0.50

# ═══ ENTRÉE ═══
CURVE_ENTRY_MIN_PROGRESS=0.45
CURVE_ENTRY_MAX_PROGRESS=0.85
MAX_CONCURRENT_CURVE_POSITIONS=5
KELLY_FRACTION=0.25
MAX_POSITION_SOL=0.50
MIN_POSITION_SOL=0.03
PAPER_BANKROLL_SOL=2.0

# ═══ GRADUATION EXIT ═══
GRAD_T1_PCT=0.40
GRAD_T2_PCT=0.35
GRAD_T2_DELAY_MS=60000
GRAD_T3_DELAY_MS=300000

# ═══ SOCIAL ═══
XAI_API_KEY=                        # Grok
XAI_BASE_URL=https://api.x.ai/v1
XAI_MODEL=grok-4-1-fast
GROQ_API_KEY=                       # NLP Pipeline
TELEGRAM_API_ID=                    # Telegram
TELEGRAM_API_HASH=

# ═══ RPC ═══
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=XXX
RPC_URL=https://mainnet.helius-rpc.com/?api-key=XXX

# ═══ PERSISTANCE ═══
CURVE_POSITION_PERSIST=1
PAPER_TRADE_LOG=1

# ═══ MODE ═══
STRATEGY_MODE=curve-prediction
TRADING_MODE=paper
```

---

## ORDRE D'EXÉCUTION STRICT

```
1. PROMPT 0 — Rotation agressive (30 min)
   → Relancer 30 min → vérifier positions qui se ferment < 5 min
   → STOP si ça ne marche pas — fix avant de continuer

2. PROMPT 1 — Fix données (30 min)  
   → Outcomes > 0, snapshots qui bougent
   → Exécuter : bun scripts/export-ml-dataset.ts
   → OUVRIR data/curve_snapshots.csv dans Excel/Google Sheets → vérifier lisible

3. PROMPT 2 — Grok X Search (2h)
4. PROMPT 3 — Telegram (1h30)
5. PROMPT 4 — DexScreener (45 min)
6. PROMPT 5 — Whale DB (1h)
7. PROMPT 6 — Stratégie Quant (1h)

TOTAL : ~8h de sessions Cursor
PUIS : Run 24-48h continu pour collecte de données
PUIS : bun scripts/export-ml-dataset.ts → CSV pour training ML
```

---

## POURQUOI TES FICHIERS DONNÉES SONT "BUGGÉS"

Ce n'est PAS un bug. Les fichiers data/apex.db sont en format SQLite BINAIRE.
C'est un format de base de données, pas du texte. Quand tu l'ouvres dans un
éditeur de texte (VS Code, Notepad), tu vois des caractères aléatoires — c'est
normal.

POUR LIRE LES DONNÉES, 3 options :

1. Le script export-ml-dataset.ts (Prompt 1) → convertit en CSV lisible
2. DB Browser for SQLite (app gratuite) → https://sqlitebrowser.org/
3. Extension VS Code "SQLite Viewer" → visualise .db dans VS Code

Le fichier data/paper_trades.jsonl est en JSONL (JSON Lines) — chaque ligne
est un objet JSON. Ça se lit dans un éditeur de texte, mais c'est plus facile
en CSV. Le script d'export le convertit aussi.