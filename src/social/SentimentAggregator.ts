/**
 * Fuse Grok X + Virality (Telegram/NLP path) + DexScreener token-boost flag → composite [0,1] for GraduationPredictor.
 */

import type { TokenXSentiment } from './GrokXScanner.js';

export interface SocialComposite {
  score: number;
  updatedAt: number;
}

let singleton: SentimentAggregator | null = null;

function envBlendWeight(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

export class SentimentAggregator {
  private readonly tokenScores = new Map<string, SocialComposite>();

  /** Poids normalisés (somme > 0) — env SOCIAL_BLEND_WEIGHT_X/TG/DEX, défauts 0.5 / 0.3 / 0.2 */
  private readBlendWeights(): { wX: number; wTg: number; wDex: number } {
    const wx = envBlendWeight('SOCIAL_BLEND_WEIGHT_X', 0.5);
    const wt = envBlendWeight('SOCIAL_BLEND_WEIGHT_TG', 0.3);
    const wd = envBlendWeight('SOCIAL_BLEND_WEIGHT_DEX', 0.2);
    const sum = wx + wt + wd;
    if (sum <= 0) {
      return { wX: 0.5, wTg: 0.3, wDex: 0.2 };
    }
    return { wX: wx / sum, wTg: wt / sum, wDex: wd / sum };
  }

  /**
   * @param telegramChannelScore — score canal TG token-specific [0,1] (TelegramTokenScanner) ; null = utiliser genericVirality
   * @param genericViralityScore — ViralityScorer global (mentions live)
   */
  computeComposite(
    mint: string,
    xSentiment: TokenXSentiment | null,
    telegramChannelScore: number | null,
    genericViralityScore: number,
    dexBoostActive: boolean,
  ): number {
    const { wX, wTg, wDex } = this.readBlendWeights();
    let score = 0;
    let weightSum = 0;

    if (xSentiment && xSentiment.confidence > 0.3) {
      const xScore =
        (xSentiment.hypeLevel / 10) * xSentiment.confidence * (1 - xSentiment.botActivity);
      score += wX * xScore;
      weightSum += wX;
    }

    const tgSlot =
      telegramChannelScore != null && telegramChannelScore > 0
        ? telegramChannelScore
        : genericViralityScore;
    if (tgSlot > 0) {
      const v = Math.max(0, Math.min(1, tgSlot));
      score += wTg * v;
      weightSum += wTg;
    }

    if (dexBoostActive) {
      score += wDex * 0.7;
      weightSum += wDex;
    }

    const composite = weightSum > 0 ? score / weightSum : 0;
    this.tokenScores.set(mint, { score: composite, updatedAt: Date.now() });
    return composite;
  }

  getScore(mint: string): number {
    return this.tokenScores.get(mint)?.score ?? 0;
  }
}

export function getSentimentAggregator(): SentimentAggregator {
  if (!singleton) singleton = new SentimentAggregator();
  return singleton;
}
