/**
 * Grok X Search — cold-path social overlay (Phase C).
 * Optional: no XAI_API_KEY → all calls return null, no throw.
 * POST /v1/responses avec outil `web_search` (latence serveur souvent 30–90 s+).
 */

import { XAI_RESPONSES_WEB_TOOLS } from './xai-live-search.js';
import { fetchWithTimeout } from '../infra/fetchWithTimeout.js';

function responsesTimeoutMs(): number {
  const v = process.env.XAI_RESPONSES_TIMEOUT_MS ?? process.env.GROK_X_FETCH_TIMEOUT_MS;
  if (v === undefined || v === '') return 120_000;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 15_000 ? n : 120_000;
}

export interface TokenXSentiment {
  mentionCount: number;
  sentiment: number;
  hypeLevel: number;
  botActivity: number;
  influencerMentions: number;
  keyThemes: string[];
  confidence: number;
  fromCache: boolean;
  latencyMs: number;
}

function extractJsonObjectWithKey(text: string, key: string): string | null {
  const idx = text.indexOf(`"${key}"`);
  if (idx < 0) return null;
  const start = text.lastIndexOf('{', idx);
  if (start < 0) return null;
  let depth = 0;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  return null;
}

let singleton: GrokXScanner | null = null;

export class GrokXScanner {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly cache = new Map<string, { result: TokenXSentiment; expiry: number }>();
  private readonly CACHE_TTL: number;
  private stats = { calls: 0, cached: 0, errors: 0, totalLatencyMs: 0 };

  constructor() {
    this.apiKey = (process.env.XAI_API_KEY ?? '').trim();
    this.baseUrl = (process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1').replace(/\/$/, '');
    this.model = process.env.XAI_MODEL ?? 'grok-4-1-fast';
    this.CACHE_TTL = parseInt(process.env.GROK_TOKEN_CACHE_TTL_MS ?? '900000', 10);
  }

  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Grok par mint (X sentiment token-level). Le pipeline social courbes utilise
   * `NarrativeRadar` (marché global) — ne pas rappeler cette méthode sur chaque HOT mint.
   */
  async analyzeToken(ticker: string, mintAddress: string): Promise<TokenXSentiment | null> {
    if (!this.apiKey) return null;

    const cached = this.cache.get(mintAddress);
    if (cached && cached.expiry > Date.now()) {
      this.stats.cached++;
      return { ...cached.result, fromCache: true, latencyMs: 0 };
    }

    const t0 = performance.now();
    try {
      const response = await fetchWithTimeout(
        `${this.baseUrl}/responses`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            tools: XAI_RESPONSES_WEB_TOOLS,
            input: [
              {
                role: 'system',
                content:
                  'You are a crypto social media analyst. Analyze X/Twitter activity for the given Solana memecoin. Focus on: mention velocity (growing/stable/dying), organic vs bot hype, influencer involvement, narrative strength. Be skeptical of coordinated shilling. Return ONLY the JSON object requested.',
              },
              {
                role: 'user',
                content: `Analyze current X/Twitter buzz for Solana token $${ticker} (address: ${mintAddress.slice(0, 16)}…) in the last 30 minutes. Return ONLY JSON: {"mentionCount":0,"sentiment":0,"hypeLevel":0,"botActivity":0,"influencerMentions":0,"keyThemes":[],"confidence":0}`,
              },
            ],
            max_output_tokens: 1024,
          }),
        },
        responsesTimeoutMs(),
      );

      const rawBody = await response.text();
      if (!response.ok) {
        this.stats.errors++;
        console.warn(
          `⚠️  [GrokX] HTTP ${response.status} — ${rawBody.slice(0, 280)}${rawBody.length > 280 ? '…' : ''}`,
        );
        return null;
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        this.stats.errors++;
        console.warn(`⚠️  [GrokX] JSON parse error on response body (${rawBody.length} chars)`);
        return null;
      }
      const blocks = (Array.isArray(data.output)
        ? data.output
        : Array.isArray(data.content)
          ? data.content
          : []) as Array<{ content?: Array<{ text?: string }>; text?: string }>;

      let blob = '';
      for (const block of blocks) {
        const text = block?.content?.[0]?.text ?? block?.text ?? '';
        blob += text;
      }
      if (typeof data === 'object' && blob === '') {
        blob = JSON.stringify(data);
      }

      const jsonText = extractJsonObjectWithKey(blob, 'mentionCount');
      if (!jsonText) {
        this.stats.errors++;
        return null;
      }

      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const result: TokenXSentiment = {
        mentionCount: Math.max(0, Number(parsed.mentionCount) || 0),
        sentiment: Math.max(-1, Math.min(1, Number(parsed.sentiment) || 0)),
        hypeLevel: Math.max(0, Math.min(10, Number(parsed.hypeLevel) || 0)),
        botActivity: Math.max(0, Math.min(1, Number(parsed.botActivity) || 0)),
        influencerMentions: Math.max(0, Number(parsed.influencerMentions) || 0),
        keyThemes: Array.isArray(parsed.keyThemes)
          ? (parsed.keyThemes as string[]).slice(0, 3)
          : [],
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
        fromCache: false,
        latencyMs: performance.now() - t0,
      };

      this.cache.set(mintAddress, { result: { ...result, fromCache: false }, expiry: Date.now() + this.CACHE_TTL });
      this.stats.calls++;
      this.stats.totalLatencyMs += result.latencyMs;

      console.log(
        `🔍 [GrokX] $${ticker} | hype=${result.hypeLevel}/10 sent=${result.sentiment.toFixed(2)} ` +
          `mentions=${result.mentionCount} bot=${(result.botActivity * 100).toFixed(0)}% | ⏱️${result.latencyMs.toFixed(0)}ms`,
      );

      return result;
    } catch (err) {
      this.stats.errors++;
      console.warn(`⚠️  [GrokX] ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  getStats(): { calls: number; cached: number; errors: number; avgLatencyMs: number } {
    const c = this.stats.calls;
    return {
      calls: c,
      cached: this.stats.cached,
      errors: this.stats.errors,
      avgLatencyMs: c > 0 ? this.stats.totalLatencyMs / c : 0,
    };
  }

  pruneCache(): void {
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (v.expiry <= now) this.cache.delete(k);
    }
  }
}

export function getGrokXScanner(): GrokXScanner {
  if (!singleton) singleton = new GrokXScanner();
  return singleton;
}
