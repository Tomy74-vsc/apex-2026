/**
 * NLPPipeline — APEX-2026 Phase 2 (P2.1.1)
 *
 * 3-stage NLP pipeline for Telegram/X social signals:
 *   Stage 0: Regex cleaning + spam detection (< 1ms, deterministic)
 *   Stage 1: Groq LLM classification (< 50ms, 25 req/min)
 *   Stage 2: Deep reasoning — ONLY if Stage 1 confidence < 0.7 (< 200ms)
 *
 * Outputs a unified NLPSignal per message, consumed by FeatureAssembler.
 */

import { EventEmitter } from 'events';
import { processStage0, type Stage0Result } from './Stage0_Regex.js';
import { getStage1Groq, type Stage1Result } from './Stage1_Groq.js';
import { getViralityScorer, type MentionEvent } from './ViralityScorer.js';
import { envHttpTimeoutMs, fetchWithTimeout } from '../infra/fetchWithTimeout.js';

export interface NLPSignal {
  mint: string;
  sentiment: number;       // -1 to 1
  confidence: number;      // 0 to 1
  category: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'SPAM' | 'UNKNOWN';
  spamScore: number;       // 0 to 1 from Stage 0
  hasCallToAction: boolean;
  velocity: number;        // from ViralityScorer
  viralityScore: number;   // from ViralityScorer
  isManipulated: boolean;
  pipeline: string;        // "s0" | "s0+s1" | "s0+s1+s2"
  totalLatencyMs: number;
}

const CONFIDENCE_THRESHOLD_STAGE2 = 0.7;
const SPAM_THRESHOLD_SKIP_LLM = 0.8;

export class NLPPipeline extends EventEmitter {
  private stage1 = getStage1Groq();
  private virality = getViralityScorer();
  private stats = {
    processed: 0,
    stage0Only: 0,
    stage1Calls: 0,
    stage2Calls: 0,
    avgLatencyMs: 0,
  };

  constructor() {
    super();
    console.log('🧠 [NLPPipeline] 3-stage pipeline initialized');
  }

  /**
   * Process a raw social message through the full NLP pipeline.
   *
   * @param rawText - Raw message text
   * @param mint - Token mint address (if known from tickers or context)
   * @param platform - Source platform
   * @param authorTrust - Author trust score (0-100)
   * @param reach - Author followers/channel members
   * @param options.deferVirality — si true, n’appelle pas addMention (appelant doit appeler getViralityScorer().addMention, ex. horodatage Telegram)
   */
  async process(
    rawText: string,
    mint: string,
    platform: 'X' | 'Telegram' = 'Telegram',
    authorTrust: number = 50,
    reach: number = 100,
    options?: { deferVirality?: boolean },
  ): Promise<NLPSignal> {
    const t0 = performance.now();
    this.stats.processed++;

    // ─── Stage 0: Regex ──────────────────────────────────────────────
    const s0 = processStage0(rawText);

    // If mint not provided, try to extract from tickers
    const effectiveMint = mint || s0.solanaAddresses[0] || '';

    // Short-circuit for obvious spam
    if (s0.spamScore >= SPAM_THRESHOLD_SKIP_LLM) {
      this.stats.stage0Only++;
      const signal = this.buildSignal(effectiveMint, s0, null, 's0', t0);
      if (!options?.deferVirality) {
        this.emitMention(effectiveMint, platform, authorTrust, reach, signal.sentiment);
      }
      this.emit('nlpSignal', signal);
      return signal;
    }

    // ─── Stage 1: Groq LLM ──────────────────────────────────────────
    this.stats.stage1Calls++;
    const s1 = await this.stage1.classify(s0.cleanedText, s0.spamScore);

    let pipeline = 's0+s1';
    let finalSentiment = s1.sentiment;
    let finalConfidence = s1.confidence;
    let finalCategory = s1.category;

    // ─── Stage 2: Deep reasoning (only if low confidence) ────────────
    if (s1.confidence < CONFIDENCE_THRESHOLD_STAGE2 && !s1.rateLimited) {
      this.stats.stage2Calls++;
      pipeline = 's0+s1+s2';
      // Stage 2 uses the same Groq endpoint but with a more detailed prompt
      const s2 = await this.deepReason(s0.cleanedText, s1);
      finalSentiment = s2.sentiment;
      finalConfidence = s2.confidence;
      finalCategory = s2.category;
    }

    const signal = this.buildSignalFromStages(
      effectiveMint, s0, finalSentiment, finalConfidence, finalCategory, pipeline, t0,
    );

    if (!options?.deferVirality) {
      this.emitMention(effectiveMint, platform, authorTrust, reach, finalSentiment);
    }
    this.emit('nlpSignal', signal);

    return signal;
  }

  /**
   * Stage 2: Deep reasoning with more context.
   * Only triggered when Stage 1 confidence < 0.7.
   */
  private async deepReason(text: string, s1: Stage1Result): Promise<{
    sentiment: number;
    confidence: number;
    category: Stage1Result['category'];
  }> {
    try {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) return { sentiment: s1.sentiment, confidence: s1.confidence, category: s1.category };

      const resp = await fetchWithTimeout(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
              {
                role: 'system',
                content: `You are an expert crypto market analyst. Stage 1 classified this text as ${s1.category} with sentiment=${s1.sentiment} and confidence=${s1.confidence}. Re-analyze with deeper reasoning. Respond ONLY with JSON: {"sentiment": <-1 to 1>, "confidence": <0 to 1>, "category": "<BULLISH|BEARISH|NEUTRAL|SPAM>"}`,
              },
              { role: 'user', content: text.slice(0, 1000) },
            ],
            max_tokens: 150,
            temperature: 0.1,
          }),
        },
        envHttpTimeoutMs('HTTP_GROQ_TIMEOUT_MS', 5_000),
      );

      if (!resp.ok) return { sentiment: s1.sentiment, confidence: s1.confidence, category: s1.category };

      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) return { sentiment: s1.sentiment, confidence: s1.confidence, category: s1.category };

      const jsonMatch = content.match(/\{[^}]+\}/);
      if (!jsonMatch) return { sentiment: s1.sentiment, confidence: s1.confidence, category: s1.category };

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      return {
        sentiment: Math.max(-1, Math.min(1, Number(parsed.sentiment) || s1.sentiment)),
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || s1.confidence)),
        category: (['BULLISH', 'BEARISH', 'NEUTRAL', 'SPAM'] as const).includes(
          String(parsed.category).toUpperCase() as 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'SPAM',
        )
          ? (String(parsed.category).toUpperCase() as 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'SPAM')
          : (s1.category === 'UNKNOWN' ? 'NEUTRAL' : s1.category),
      };
    } catch {
      return { sentiment: s1.sentiment, confidence: s1.confidence, category: s1.category };
    }
  }

  private buildSignal(
    mint: string, s0: Stage0Result, s1: Stage1Result | null,
    pipeline: string, t0: number,
  ): NLPSignal {
    const v = this.virality.compute(mint);
    return {
      mint,
      sentiment: s1?.sentiment ?? (s0.spamScore > 0.5 ? -0.5 : 0),
      confidence: s1?.confidence ?? (s0.spamScore > 0.5 ? 0.7 : 0.2),
      category: s1?.category ?? (s0.spamScore > 0.5 ? 'SPAM' : 'UNKNOWN'),
      spamScore: s0.spamScore,
      hasCallToAction: s0.hasCallToAction,
      velocity: v?.velocity ?? 0,
      viralityScore: v?.viralityScore ?? 0,
      isManipulated: v?.isManipulated ?? false,
      pipeline,
      totalLatencyMs: performance.now() - t0,
    };
  }

  private buildSignalFromStages(
    mint: string, s0: Stage0Result,
    sentiment: number, confidence: number,
    category: NLPSignal['category'], pipeline: string, t0: number,
  ): NLPSignal {
    const v = this.virality.compute(mint);
    return {
      mint,
      sentiment,
      confidence,
      category,
      spamScore: s0.spamScore,
      hasCallToAction: s0.hasCallToAction,
      velocity: v?.velocity ?? 0,
      viralityScore: v?.viralityScore ?? 0,
      isManipulated: v?.isManipulated ?? false,
      pipeline,
      totalLatencyMs: performance.now() - t0,
    };
  }

  private emitMention(
    mint: string, platform: 'X' | 'Telegram',
    authorTrust: number, reach: number, sentiment: number,
  ): void {
    if (!mint) return;
    const event: MentionEvent = {
      mint,
      platform,
      authorTrustScore: authorTrust,
      reach,
      sentiment,
      timestamp: Date.now(),
    };
    this.virality.addMention(event);
  }

  getStats() {
    return {
      ...this.stats,
      stage1: this.stage1.getStats(),
      virality: this.virality.getStats(),
    };
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _pipeline: NLPPipeline | null = null;

export function getNLPPipeline(): NLPPipeline {
  if (!_pipeline) {
    _pipeline = new NLPPipeline();
  }
  return _pipeline;
}
