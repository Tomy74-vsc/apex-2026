/**
 * Fuse momentum marché global (Grok via NarrativeRadar ~15min) + Telegram + DexScreener boost → composite [0,1] for GraduationPredictor.
 * W_SOCIAL dans GraduationPredictor reste 0.07 ; seule la composition interne change (plus de Grok token-level).
 */

export interface SocialComposite {
  score: number;
  updatedAt: number;
}

export type ComputeCompositeOptions = {
  /**
   * false = calcule le blend sans écraser `tokenScores` (ex. merge boost Dex sur cache social déjà riche).
   * @default true
   */
  persist?: boolean;
};

let singleton: SentimentAggregator | null = null;

function envBlendWeight(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

export class SentimentAggregator {
  private readonly tokenScores = new Map<string, SocialComposite>();

  /**
   * Poids normalisés — SOCIAL_BLEND_WEIGHT_NARRATIVE (ou legacy SOCIAL_BLEND_WEIGHT_X), TG, DEX.
   * Défauts directive : 0.25 / 0.40 / 0.35 (narratif global / Telegram / boost payant).
   */
  private readBlendWeights(): { wNarr: number; wTg: number; wDex: number } {
    const wn = envBlendWeight(
      'SOCIAL_BLEND_WEIGHT_NARRATIVE',
      envBlendWeight('SOCIAL_BLEND_WEIGHT_X', 0.25),
    );
    const wt = envBlendWeight('SOCIAL_BLEND_WEIGHT_TG', 0.4);
    const wd = envBlendWeight('SOCIAL_BLEND_WEIGHT_DEX', 0.35);
    const sum = wn + wt + wd;
    if (sum <= 0) {
      return { wNarr: 0.25, wTg: 0.4, wDex: 0.35 };
    }
    return { wNarr: wn / sum, wTg: wt / sum, wDex: wd / sum };
  }

  /**
   * @param narrativeMarketScore — [0,1] partagé tous les tokens (Grok scan marché ~15min)
   * @param telegramChannelScore — TelegramTokenScanner [0,1] ; null → genericViralityScore
   * @param genericViralityScore — ViralityScorer (fallback TG)
   * @param dexBoostActive — token dans le feed boosts DexScreener (engagement payant dev)
   * @param options.persist — si false, ne met pas à jour la map interne (évite d’écraser un composite riche avec un dex-only).
   *
   * Sans signal TG/virality (tg=0) : on retire wTg du dénominateur pour garder un max ~1.0 avec narr+dex seuls (Guérilla sans GramJS).
   */
  computeComposite(
    mint: string,
    narrativeMarketScore: number,
    telegramChannelScore: number | null,
    genericViralityScore: number,
    dexBoostActive: boolean,
    options?: ComputeCompositeOptions,
  ): number {
    const { wNarr, wTg, wDex } = this.readBlendWeights();
    const narr = Math.max(0, Math.min(1, narrativeMarketScore));
    const tgSlot =
      telegramChannelScore != null && telegramChannelScore > 0
        ? telegramChannelScore
        : genericViralityScore;
    const tg = Math.max(0, Math.min(1, tgSlot));
    const dex = dexBoostActive ? 1 : 0;

    const tgActive = tg > 1e-12;
    const numer = narr * wNarr + tg * wTg + dex * wDex;
    const denom = wNarr + (tgActive ? wTg : 0) + wDex;
    const composite = denom > 0 ? numer / denom : 0;

    if (options?.persist !== false) {
      this.tokenScores.set(mint, { score: composite, updatedAt: Date.now() });
    }
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
