/**
 * Multi-layer curve pre-check (cache 5 min, 8s global budget) — gates before AIBrain.decideCurve.
 * Kelly / position size stay solely in AIBrain.decideCurve.
 */

import type {
  FullCurveAnalysis,
  FullCurveAnalysisVerdict,
  SecurityReport,
} from '../types/index.js';
import type { TrackedCurve, CurveTradeEvent } from '../types/bonding-curve.js';
import type { VelocitySignal } from '../modules/graduation-predictor/VelocityAnalyzer.js';
import { Guard } from './Guard.js';
import { WalletScorer } from '../modules/graduation-predictor/WalletScorer.js';
import { BotDetector } from '../modules/graduation-predictor/BotDetector.js';
import { getHolderDistributionOracle } from '../modules/graduation-predictor/HolderDistribution.js';
import { defaultDexScreenerTimeoutMs, fetchWithTimeout } from '../infra/fetchWithTimeout.js';
import { getNarrativeRadar } from '../social/NarrativeRadar.js';
import { getSocialTrendScanner } from '../ingestors/SocialTrendScanner.js';
import { getTelegramTokenScanner } from '../ingestors/TelegramTokenScanner.js';
import { getViralityScorer } from '../nlp/ViralityScorer.js';
import { getSentimentAggregator } from '../social/SentimentAggregator.js';

const CACHE_TTL_MS = 5 * 60_000;
const GLOBAL_ANALYSIS_MS = 8000;
const SECURITY_LAYER_MS = 5000;

function envFloat(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

function envInt(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function layerTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.then((x) => x),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function countDexSocialRedHits(pairs: unknown): number {
  const hay = JSON.stringify(pairs ?? []).toLowerCase();
  const needles = [
    'rug pull',
    'honeypot',
    'scammer',
    'scam',
    'dump now',
    'sell now',
    'exit liquidity',
    'pull liquidity',
  ];
  let hits = 0;
  for (const n of needles) {
    if (hay.includes(n)) hits++;
  }
  return hits;
}

let singleton: CurveTokenAnalyzer | null = null;

export function getCurveTokenAnalyzer(): CurveTokenAnalyzer {
  if (!singleton) singleton = new CurveTokenAnalyzer();
  return singleton;
}

export class CurveTokenAnalyzer {
  private readonly guard = new Guard();
  private readonly walletScorer = new WalletScorer();
  private readonly botDetector = new BotDetector();
  private readonly cache = new Map<string, { at: number; value: FullCurveAnalysis }>();
  private readonly inflight = new Map<string, Promise<FullCurveAnalysis>>();
  private readonly progressBuf = new Map<string, number[]>();

  /** Même sémantique que Guard.validateCurveForExecution : full on-chain+Jupiter uniquement si `1`. */
  private static isCurveFullGuardEnabled(): boolean {
    return (process.env.CURVE_FULL_GUARD ?? '').trim() === '1';
  }

  /** Pas d’appel Guard.analyzeToken — autres couches (holders, liquidité proxy, social) restent actives. */
  private securityLayerSkipped(mint: string): SecurityReport {
    return {
      mint,
      isSafe: true,
      riskScore: 0,
      flags: [],
      details: {
        mintRenounced: true,
        freezeDisabled: true,
        lpBurnedPercent: 0,
        top10HoldersPercent: 0,
        isHoneypot: false,
      },
    };
  }

  getCached(mint: string): FullCurveAnalysis | null {
    const row = this.cache.get(mint);
    if (!row || Date.now() - row.at > CACHE_TTL_MS) return null;
    return row.value;
  }

  /**
   * Fire-and-forget safe: dedupes concurrent analyzes per mint.
   */
  analyze(curve: TrackedCurve, velocity: VelocitySignal, trades: CurveTradeEvent[]): Promise<FullCurveAnalysis> {
    const { mint } = curve;
    const hit = this.getCached(mint);
    if (hit) return Promise.resolve(hit);
    let job = this.inflight.get(mint);
    if (!job) {
      job = this.runAnalysis(curve, velocity, trades).finally(() => {
        this.inflight.delete(mint);
      });
      this.inflight.set(mint, job);
    }
    return job;
  }

  private pushProgress(mint: string, progress: number): boolean {
    const buf = [...(this.progressBuf.get(mint) ?? []), progress];
    while (buf.length > 3) buf.shift();
    this.progressBuf.set(mint, buf);
    if (buf.length < 3) return false;
    const [a, b, c] = buf;
    return a !== undefined && b !== undefined && c !== undefined && a > b && b > c;
  }

  private async runAnalysis(
    curve: TrackedCurve,
    velocity: VelocitySignal,
    trades: CurveTradeEvent[],
  ): Promise<FullCurveAnalysis> {
    const tStart = performance.now();
    const mint = curve.mint;

    const run = async (): Promise<FullCurveAnalysis> => {
      const securityP = CurveTokenAnalyzer.isCurveFullGuardEnabled()
        ? layerTimeout(this.guard.analyzeToken(mint), SECURITY_LAYER_MS)
        : Promise.resolve(this.securityLayerSkipped(mint));
      const holdersP = Promise.resolve().then(() => {
        const t0 = performance.now();
        const oracle = getHolderDistributionOracle().getCachedShare(mint);
        const creatorB58 = curve.state.creator.toBase58();
        const ws = this.walletScorer.analyze(trades, creatorB58);
        const real = trades.filter((t) => !t.synthetic);
        const buySol = real.filter((t) => t.isBuy).reduce((s, t) => s + t.solAmount, 0);
        const creatorBuySol = real.filter((t) => t.isBuy && t.trader === creatorB58).reduce((s, t) => s + t.solAmount, 0);
        const creatorBuyVolumeShare = buySol > 1e-12 ? creatorBuySol / buySol : 0;
        return {
          top10Share: oracle ?? ws.top10BuyVolumeShare,
          freshWalletRatio: ws.freshWalletRatio,
          creatorIsSelling: ws.creatorIsSelling,
          creatorTokenCount: ws.creatorTokenCount,
          creatorHistoricalGradRate: ws.creatorHistoricalGradRate,
          creatorBuyVolumeShare,
          ms: performance.now() - t0,
        };
      });
      const liquidityP = Promise.resolve().then(() => {
        const t0 = performance.now();
        const regressing = this.pushProgress(mint, curve.progress);
        const bot = this.botDetector.analyze(trades);
        return {
          progressRegressing: regressing,
          solPerMinuteHint: velocity.solPerMinute_1m,
          botTransactionRatio: bot.botTransactionRatio,
          ms: performance.now() - t0,
        };
      });
      const socialP = this.analyzeSocialLayer(curve);

      const settled = await Promise.allSettled([securityP, holdersP, liquidityP, socialP]);

      let security: FullCurveAnalysis['security'] = null;
      if (settled[0].status === 'fulfilled' && settled[0].value) {
        const s = settled[0].value;
        security = {
          riskScore: s.riskScore,
          isSafe: s.isSafe,
          flags: [...s.flags],
          isHoneypot: s.details?.isHoneypot === true,
          latencyMs: Math.round(SECURITY_LAYER_MS * 0.5),
        };
      }

      let holders: FullCurveAnalysis['holders'] = null;
      if (settled[1].status === 'fulfilled') {
        const h = settled[1].value;
        holders = {
          top10Share: h.top10Share,
          top10Concentration: h.top10Share,
          freshWalletRatio: h.freshWalletRatio,
          creatorIsSelling: h.creatorIsSelling,
          creatorTokenCount: h.creatorTokenCount,
          creatorHistoricalGradRate: h.creatorHistoricalGradRate,
          creatorBuyVolumeShare: h.creatorBuyVolumeShare,
          devHolding: h.creatorBuyVolumeShare,
          latencyMs: h.ms,
        };
      }

      let liquidity: FullCurveAnalysis['liquidity'] = null;
      if (settled[2].status === 'fulfilled') {
        const l = settled[2].value;
        liquidity = {
          progressRegressing: l.progressRegressing,
          solPerMinuteHint: l.solPerMinuteHint,
          botTransactionRatio: l.botTransactionRatio,
          latencyMs: l.ms,
        };
      }

      let social: FullCurveAnalysis['social'] = null;
      if (settled[3].status === 'fulfilled' && settled[3].value) {
        social = settled[3].value;
      }

      const partial =
        settled[0].status === 'rejected' ||
        (settled[0].status === 'fulfilled' && settled[0].value === null) ||
        settled[1].status === 'rejected' ||
        settled[2].status === 'rejected';

      const verdict = this.buildVerdict(
        security,
        holders,
        liquidity,
        social,
        curve,
        velocity,
        trades,
        performance.now() - tStart,
      );

      const out: FullCurveAnalysis = {
        mint,
        timestampMs: Date.now(),
        partial: partial || !security || !holders || !liquidity,
        security,
        holders,
        liquidity,
        social,
        verdict,
      };
      this.cache.set(mint, { at: Date.now(), value: out });
      console.log(
        `🔬 [CurveAnalyzer] ${mint.slice(0, 8)}… | score=${out.verdict.compositeScore.toFixed(2)} | verdict=${out.verdict.passed ? 'ENTER' : 'SKIP'} | conf=${out.verdict.confidence.toFixed(2)} ⏱️${out.verdict.latencyMs.toFixed(0)}ms`,
      );
      return out;
    };

    try {
      return await Promise.race([
        run(),
        new Promise<FullCurveAnalysis>((resolve) =>
          setTimeout(() => {
            const latencyMs = performance.now() - tStart;
            const verdict: FullCurveAnalysisVerdict = {
              passed: false,
              recommendedAction: 'SKIP',
              compositeScore: 0,
              confidence: 0.2,
              vetoFlags: ['global_timeout'],
              latencyMs,
            };
            const out: FullCurveAnalysis = {
              mint,
              timestampMs: Date.now(),
              partial: true,
              security: null,
              holders: null,
              liquidity: null,
              social: null,
              verdict,
            };
            this.cache.set(mint, { at: Date.now(), value: out });
            resolve(out);
          }, GLOBAL_ANALYSIS_MS),
        ),
      ]);
    } catch {
      const latencyMs = performance.now() - tStart;
      const verdict: FullCurveAnalysisVerdict = {
        passed: false,
        recommendedAction: 'SKIP',
        compositeScore: 0,
        confidence: 0.2,
        vetoFlags: ['analysis_error'],
        latencyMs,
      };
      const out: FullCurveAnalysis = {
        mint,
        timestampMs: Date.now(),
        partial: true,
        security: null,
        holders: null,
        liquidity: null,
        social: null,
        verdict,
      };
      this.cache.set(mint, { at: Date.now(), value: out });
      return out;
    }
  }

  /**
   * Couche sociale : momentum marché global (Grok partagé) + Telegram + boost DexScreener (mêmes poids que SentimentAggregator).
   * Pas de Grok par token — économie crédits xAI.
   */
  private async analyzeSocialLayer(curve: TrackedCurve): Promise<FullCurveAnalysis['social']> {
    const t0 = performance.now();
    const mint = curve.mint;

    let dexPairFound = false;
    let pairs: unknown[] | undefined;
    try {
      const res = await fetchWithTimeout(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        { method: 'GET' },
        Math.min(4000, defaultDexScreenerTimeoutMs()),
      );
      if (res.ok) {
        const j = (await res.json()) as { pairs?: unknown[] };
        pairs = j.pairs;
        dexPairFound = Array.isArray(pairs) && pairs.length > 0;
      }
    } catch {
      /* cold path */
    }

    const socialRedFlagHits = countDexSocialRedHits(pairs);
    const narrativeMarketScore = getNarrativeRadar().getGlobalMarketMomentum();
    const dexBoostActive = getSocialTrendScanner().isBoosted(mint);

    let telegramChannelScore: number | null = null;
    try {
      const tr = await getTelegramTokenScanner().analyzeMint(mint, curve.metadata ?? {}, null);
      if (tr && tr.source !== 'none' && tr.compositeScore > 0) {
        telegramChannelScore = tr.compositeScore;
      }
    } catch {
      /* cold path */
    }

    const viralityScore = getViralityScorer().getViralityScore(mint);
    const socialLayerComposite = getSentimentAggregator().computeComposite(
      mint,
      narrativeMarketScore,
      telegramChannelScore,
      viralityScore,
      dexBoostActive,
    );

    const telegramScore =
      telegramChannelScore != null && telegramChannelScore > 0
        ? telegramChannelScore
        : viralityScore;

    return {
      dexPairFound,
      narrativeMarketScore,
      grokSentiment: narrativeMarketScore,
      telegramScore: Math.max(0, Math.min(1, telegramScore)),
      dexBoostActive,
      socialLayerComposite,
      socialRedFlagHits,
      telegramRedFlags: socialRedFlagHits,
      latencyMs: performance.now() - t0,
    };
  }

  private buildVerdict(
    security: FullCurveAnalysis['security'],
    holders: FullCurveAnalysis['holders'],
    liquidity: FullCurveAnalysis['liquidity'],
    social: FullCurveAnalysis['social'],
    curve: TrackedCurve,
    velocity: VelocitySignal,
    trades: CurveTradeEvent[],
    latencyMs: number,
  ): FullCurveAnalysisVerdict {
    const flags: string[] = [];
    const maxRisk = envFloat('CURVE_ANALYZER_MAX_RISK', envFloat('MAX_RISK_SCORE', 50));
    const maxFresh = envFloat('CURVE_ANALYZER_MAX_FRESH_WALLET', 0.85);
    const maxTop10Frac = envFloat('VETO_MAX_TOP10_PCT', 80) / 100;
    const maxDevHoldFrac = envFloat('VETO_MAX_DEV_HOLDING', 15) / 100;
    const vetoBotRatio = envFloat('VETO_BOT_RATIO', 0.7);
    const minTradingIntensity = envFloat('MIN_TRADING_INTENSITY', 0.15);
    const vetoMaxAgeMin = envFloat('VETO_MAX_AGE_MINUTES', 45);
    const vetoMinFreshProgress = envFloat('VETO_MIN_FRESH_PROGRESS', 0.6);
    const progressRegressMax = envFloat('CURVE_ANALYZER_PROGRESS_REGRESS_MAX', 0.6);
    const socialRedMin = envInt('CURVE_ANALYZER_SOCIAL_RED_MIN_HITS', 3);
    const serialMinTokens = envInt('CURVE_ANALYZER_SERIAL_MIN_CREATOR_TOKENS', 10);
    const serialMaxGradRate = envFloat('CURVE_ANALYZER_SERIAL_MAX_GRAD_RATE', 0.05);
    const realBuyCount = trades.filter((t) => t.isBuy && !t.synthetic).length;
    const botSnap = this.botDetector.analyze(trades);

    // V1–V2b — sécurité : absence de couche (timeout / erreur) = pas de véto ; seuls honeypot / risk explicites bloquent.
    if (security) {
      if (!security.isSafe) flags.push('V1_not_safe');
      if (security.riskScore > maxRisk) flags.push('V2_risk_score');
      if (security.isHoneypot) flags.push('V2b_honeypot');
    }

    const top10Conc = holders ? (holders.top10Concentration ?? holders.top10Share) : 0;
    const devHold = holders ? (holders.devHolding ?? holders.creatorBuyVolumeShare) : 0;
    const tgRed = social ? (social.telegramRedFlags ?? social.socialRedFlagHits) : 0;

    if (holders) {
      if (holders.creatorIsSelling) flags.push('V3_creator_selling');
      if (holders.freshWalletRatio > maxFresh) flags.push('V4_fresh_wallets');
      // V6 — champs créateur via WalletScorer (holders) ; équivalent directive "security.creator*" sans dupliquer Guard.
      if (
        holders.creatorTokenCount > serialMinTokens &&
        holders.creatorHistoricalGradRate < serialMaxGradRate
      ) {
        flags.push('V6_serial_rugger');
      }
      if (devHold > maxDevHoldFrac) flags.push('V7_dev_holding');
      if (top10Conc > maxTop10Frac) flags.push('V8_whale_concentration');
    }

    if (liquidity) {
      if (botSnap.isVeto || liquidity.botTransactionRatio > vetoBotRatio) {
        flags.push('V4b_bot_ratio');
      }
      if (liquidity.progressRegressing && curve.progress < progressRegressMax) {
        flags.push('V10_progress_regressing');
      }
    }

    if (social && tgRed >= socialRedMin) {
      flags.push('V9_social_red_flags');
    }

    if (realBuyCount >= 3 && velocity.avgTradeSize_SOL < minTradingIntensity) {
      flags.push('low_trading_intensity');
    }

    const ageMinutes = (Date.now() - curve.createdAt) / 60_000;
    if (ageMinutes > vetoMaxAgeMin && curve.progress < vetoMinFreshProgress) {
      flags.push('stale_momentum');
    }

    if (social && !social.dexPairFound && envFloat('CURVE_ANALYZER_REQUIRE_DEX_PAIR', 0) >= 1) {
      flags.push('OPT_no_dex_pair');
    }

    const securityReal = (process.env.CURVE_FULL_GUARD ?? '').trim() === '1';
    const secWeight = securityReal ? 0.2 : 0.03;
    /** Sans analyzeToken réel, holders/social ne doivent pas gonfler la confiance comme une preuve on-chain. */
    const layerMult = securityReal ? 1 : 0.45;

    let compositeScore = 0.5;
    if (security) {
      compositeScore += (1 - Math.min(1, security.riskScore / 100)) * secWeight;
    }
    if (holders) {
      compositeScore +=
        ((1 - holders.top10Share) * 0.15 + (1 - holders.freshWalletRatio) * 0.1) * layerMult;
    }
    if (social && social.socialLayerComposite > 0) {
      compositeScore += social.socialLayerComposite * 0.1 * layerMult;
    }
    compositeScore = Math.max(0, Math.min(1, compositeScore));

    const finalPassed = flags.length === 0;
    const rawPassedConf = Math.min(0.8, 0.32 + compositeScore * 0.48);
    const confidence = finalPassed
      ? securityReal
        ? rawPassedConf
        : Math.min(0.44, rawPassedConf)
      : 0.22;

    return {
      passed: finalPassed,
      recommendedAction: finalPassed ? 'ENTER' : 'SKIP',
      compositeScore,
      confidence,
      vetoFlags: flags,
      latencyMs,
    };
  }
}

// TEST MANUEL (ne pas exécuter au boot) :
// bun -e "import { getCurveTokenAnalyzer } from './src/detectors/CurveTokenAnalyzer.js';
//   const a = getCurveTokenAnalyzer();
//   // Construire un fake FullCurveAnalysis avec holders.devHolding=0.20 → buildVerdict doit SKIP + V7_dev_holding
// "
