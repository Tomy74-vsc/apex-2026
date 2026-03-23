/**
 * Stage1_Groq — APEX-2026 NLP Pipeline Stage 1 (P2.1.1)
 *
 * Fast sentiment classification via Groq free-tier LLM API.
 * Uses compact models (llama-3.1-8b-instant) for < 50ms latency.
 *
 * Guerrilla constraints:
 *   - Free tier: ~30 requests/minute
 *   - Rate limiter with token bucket
 *   - Fallback to regex-based scoring if rate limited
 *
 * Returns: sentiment (-1 to 1), confidence (0 to 1), and classification.
 */

import { envHttpTimeoutMs, fetchWithTimeout } from '../infra/fetchWithTimeout.js';

export interface Stage1Result {
  sentiment: number;     // -1 (bearish) to 1 (bullish)
  confidence: number;    // 0 to 1
  category: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'SPAM' | 'UNKNOWN';
  model: string;
  latencyMs: number;
  fromCache: boolean;
  rateLimited: boolean;
}

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';
const GROQ_TIMEOUT_MS = 3_000;

// Rate limiter: 25 req/min to stay under 30 limit
const RATE_LIMIT_PER_MIN = 25;
const RATE_WINDOW_MS = 60_000;

// Simple LRU cache for repeated texts
const CACHE_MAX = 200;

const SYSTEM_PROMPT = `You are a crypto sentiment classifier. Analyze the message and respond with ONLY a JSON object:
{"sentiment": <-1 to 1>, "confidence": <0 to 1>, "category": "<BULLISH|BEARISH|NEUTRAL|SPAM>"}

Rules:
- BULLISH: positive outlook, buy signals, excitement about token
- BEARISH: negative outlook, warnings, sell signals
- NEUTRAL: informational, no clear direction
- SPAM: bot-like, scam, airdrop farming
- sentiment: -1 (extreme bearish) to 1 (extreme bullish)
- confidence: how sure you are (0.5 = uncertain, 1.0 = very confident)

Respond ONLY with the JSON, no other text.`;

export class Stage1Groq {
  private apiKey: string | null;
  private requestTimestamps: number[] = [];
  private cache: Map<string, Stage1Result> = new Map();
  private cacheKeys: string[] = [];
  private stats = {
    requests: 0,
    cached: 0,
    rateLimited: 0,
    errors: 0,
    fallbacks: 0,
  };

  constructor() {
    this.apiKey = process.env.GROQ_API_KEY ?? null;
    if (!this.apiKey) {
      console.warn('⚠️  [Stage1_Groq] GROQ_API_KEY not set — will use fallback scoring');
    } else {
      console.log('✅ [Stage1_Groq] Initialized with Groq API');
    }
  }

  async classify(text: string, spamScore: number = 0): Promise<Stage1Result> {
    const t0 = performance.now();

    // Cache check
    const cacheKey = text.slice(0, 200);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.stats.cached++;
      return { ...cached, fromCache: true };
    }

    // If spam score already high, skip API call
    if (spamScore > 0.7) {
      return this.buildResult(-0.5, 0.8, 'SPAM', 'regex-spam', t0, false, false);
    }

    // Rate limit check
    if (!this.canMakeRequest()) {
      this.stats.rateLimited++;
      const fallback = this.fallbackClassify(text);
      return { ...fallback, latencyMs: performance.now() - t0, rateLimited: true };
    }

    // No API key → fallback
    if (!this.apiKey) {
      this.stats.fallbacks++;
      const fallback = this.fallbackClassify(text);
      return { ...fallback, latencyMs: performance.now() - t0 };
    }

    // Groq API call
    try {
      this.recordRequest();
      this.stats.requests++;

      const resp = await fetchWithTimeout(
        GROQ_API_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: GROQ_MODEL,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: text.slice(0, 500) },
            ],
            max_tokens: 100,
            temperature: 0.1,
          }),
        },
        envHttpTimeoutMs('HTTP_GROQ_TIMEOUT_MS', GROQ_TIMEOUT_MS),
      );

      if (!resp.ok) {
        if (resp.status === 429) {
          this.stats.rateLimited++;
          const fallback = this.fallbackClassify(text);
          return { ...fallback, latencyMs: performance.now() - t0, rateLimited: true };
        }
        throw new Error(`Groq API ${resp.status}`);
      }

      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('Empty Groq response');

      const parsed = this.parseGroqResponse(content);
      const result = this.buildResult(
        parsed.sentiment, parsed.confidence, parsed.category,
        GROQ_MODEL, t0, false, false,
      );

      // Cache
      this.addToCache(cacheKey, result);

      return result;
    } catch (err) {
      this.stats.errors++;
      const fallback = this.fallbackClassify(text);
      return { ...fallback, latencyMs: performance.now() - t0 };
    }
  }

  private parseGroqResponse(content: string): {
    sentiment: number;
    confidence: number;
    category: Stage1Result['category'];
  } {
    try {
      const jsonMatch = content.match(/\{[^}]+\}/);
      if (!jsonMatch) throw new Error('No JSON found');

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const sentiment = Math.max(-1, Math.min(1, Number(parsed.sentiment) || 0));
      const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5));
      const rawCat = String(parsed.category ?? 'NEUTRAL').toUpperCase();
      const validCats: Stage1Result['category'][] = ['BULLISH', 'BEARISH', 'NEUTRAL', 'SPAM', 'UNKNOWN'];
      const category: Stage1Result['category'] = validCats.includes(rawCat as Stage1Result['category'])
        ? (rawCat as Stage1Result['category'])
        : 'NEUTRAL';

      return { sentiment, confidence, category };
    } catch {
      return { sentiment: 0, confidence: 0.3, category: 'NEUTRAL' };
    }
  }

  /**
   * Regex-based fallback when Groq is unavailable or rate-limited.
   */
  private fallbackClassify(text: string): Stage1Result {
    this.stats.fallbacks++;
    const lower = text.toLowerCase();

    const bullishWords = ['moon', 'pump', 'bullish', 'lfg', 'gem', 'alpha', 'buy', 'ape', 'rocket', 'send'];
    const bearishWords = ['dump', 'rug', 'scam', 'bearish', 'sell', 'dead', 'avoid', 'warning', 'honeypot'];

    let bullCount = 0;
    let bearCount = 0;
    for (const w of bullishWords) {
      if (lower.includes(w)) bullCount++;
    }
    for (const w of bearishWords) {
      if (lower.includes(w)) bearCount++;
    }

    const total = bullCount + bearCount;
    if (total === 0) {
      return this.buildResult(0, 0.3, 'NEUTRAL', 'regex-fallback', 0, false, false);
    }

    const sentiment = (bullCount - bearCount) / total;
    const category: Stage1Result['category'] = sentiment > 0.2 ? 'BULLISH' : sentiment < -0.2 ? 'BEARISH' : 'NEUTRAL';
    return this.buildResult(sentiment, 0.4, category, 'regex-fallback', 0, false, false);
  }

  private buildResult(
    sentiment: number, confidence: number,
    category: Stage1Result['category'], model: string,
    t0: number, fromCache: boolean, rateLimited: boolean,
  ): Stage1Result {
    return {
      sentiment,
      confidence,
      category,
      model,
      latencyMs: t0 > 0 ? performance.now() - t0 : 0,
      fromCache,
      rateLimited,
    };
  }

  private canMakeRequest(): boolean {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < RATE_WINDOW_MS);
    return this.requestTimestamps.length < RATE_LIMIT_PER_MIN;
  }

  private recordRequest(): void {
    this.requestTimestamps.push(Date.now());
  }

  private addToCache(key: string, result: Stage1Result): void {
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cacheKeys.shift();
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, result);
    this.cacheKeys.push(key);
  }

  getStats() {
    return { ...this.stats, cacheSize: this.cache.size };
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _stage1: Stage1Groq | null = null;

export function getStage1Groq(): Stage1Groq {
  if (!_stage1) {
    _stage1 = new Stage1Groq();
  }
  return _stage1;
}
