/**
 * Fuse Grok X + Virality (Telegram/NLP path) + DexScreener token-boost flag → composite [0,1] for GraduationPredictor.
 */

import type { TokenXSentiment } from './GrokXScanner.js';

export interface SocialComposite {
  score: number;
  updatedAt: number;
}

let singleton: SentimentAggregator | null = null;

export class SentimentAggregator {
  private readonly W_X = 0.5;
  private readonly W_TG = 0.3;
  private readonly W_DEX = 0.2;
  private readonly tokenScores = new Map<string, SocialComposite>();

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
    let score = 0;
    let weightSum = 0;

    if (xSentiment && xSentiment.confidence > 0.3) {
      const xScore =
        (xSentiment.hypeLevel / 10) * xSentiment.confidence * (1 - xSentiment.botActivity);
      score += this.W_X * xScore;
      weightSum += this.W_X;
    }

    const tgSlot =
      telegramChannelScore != null && telegramChannelScore > 0
        ? telegramChannelScore
        : genericViralityScore;
    if (tgSlot > 0) {
      const v = Math.max(0, Math.min(1, tgSlot));
      score += this.W_TG * v;
      weightSum += this.W_TG;
    }

    if (dexBoostActive) {
      score += this.W_DEX * 0.7;
      weightSum += this.W_DEX;
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
