/**
 * Background narrative trends via Grok X Search (Phase C). Optional API key.
 */

import { EventEmitter } from 'events';
import { XAI_RESPONSES_WEB_TOOLS } from './xai-live-search.js';

export interface NarrativeSignal {
  theme: string;
  velocity: number;
  keywords: string[];
  tickers: string[];
  contractAddresses: string[];
  confidence: number;
  detectedAt: number;
}

function extractJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

let singleton: NarrativeRadar | null = null;

export class NarrativeRadar extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly SCAN_MS: number;
  private readonly activeNarratives = new Map<string, NarrativeSignal>();
  private readonly MAX_NARRATIVES = 50;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private scanning = false;

  constructor() {
    super();
    this.apiKey = (process.env.XAI_API_KEY ?? '').trim();
    this.baseUrl = (process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1').replace(/\/$/, '');
    this.model = process.env.XAI_MODEL ?? 'grok-4-1-fast';
    this.SCAN_MS = parseInt(process.env.NARRATIVE_SCAN_INTERVAL_MS ?? '120000', 10);
  }

  async start(): Promise<void> {
    if (!this.apiKey) {
      console.log('⚠️ [NarrativeRadar] disabled (no XAI_API_KEY)');
      return;
    }

    await this.scanTrends().catch(() => {});

    this.interval = setInterval(() => {
      void this.scanTrends().catch(() => {});
    }, this.SCAN_MS);

    console.log(`🔍 [NarrativeRadar] Started — scanning X trends every ${this.SCAN_MS / 1000}s`);
  }

  private async scanTrends(): Promise<void> {
    if (!this.apiKey || this.scanning) return;
    this.scanning = true;
    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
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
                'You are a real-time crypto trend detector. Identify EMERGING narratives and viral moments on X related to Solana memecoins. Focus on: new meme trends, influencer pumps, breaking news that spawns tokens. Only report trends from the LAST 30 MINUTES. Return ONLY the JSON array.',
            },
            {
              role: 'user',
              content:
                'What Solana memecoins, crypto memes, or narratives are suddenly trending or going viral on X RIGHT NOW in the last 30 minutes? Return ONLY JSON array: [{"theme":"...","velocity":1,"keywords":["..."],"tickers":["$..."],"contractAddresses":["..."],"confidence":0}]',
            },
          ],
          max_output_tokens: 2048,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      const rawBody = await response.text();
      if (!response.ok) {
        console.warn(
          `⚠️  [NarrativeRadar] HTTP ${response.status} — ${rawBody.slice(0, 240)}${rawBody.length > 240 ? '…' : ''}`,
        );
        return;
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        console.warn(`⚠️  [NarrativeRadar] JSON parse error (${rawBody.length} chars)`);
        return;
      }
      const blocks = (Array.isArray(data.output)
        ? data.output
        : Array.isArray(data.content)
          ? data.content
          : []) as Array<{ content?: Array<{ text?: string }>; text?: string }>;

      let blob = '';
      for (const block of blocks) {
        blob += block?.content?.[0]?.text ?? block?.text ?? '';
      }
      if (!blob) blob = JSON.stringify(data);

      const arrText = extractJsonArray(blob);
      if (!arrText) return;

      let items: unknown[];
      try {
        items = JSON.parse(arrText) as unknown[];
      } catch {
        return;
      }
      if (!Array.isArray(items)) return;

      const now = Date.now();
      for (const raw of items) {
        if (typeof raw !== 'object' || raw === null) continue;
        const o = raw as Record<string, unknown>;
        const theme = String(o.theme ?? '').trim();
        const velocity = Number(o.velocity) || 0;
        if (!theme || velocity < 5) continue;

        const signal: NarrativeSignal = {
          theme,
          velocity: Math.max(1, Math.min(10, velocity)),
          keywords: Array.isArray(o.keywords) ? (o.keywords as string[]).map((s) => String(s).toLowerCase()) : [],
          tickers: Array.isArray(o.tickers) ? (o.tickers as string[]).map((s) => String(s).toUpperCase()) : [],
          contractAddresses: Array.isArray(o.contractAddresses)
            ? (o.contractAddresses as string[]).map(String)
            : [],
          confidence: Math.max(0, Math.min(1, Number(o.confidence) || 0.5)),
          detectedAt: now,
        };

        const key = theme.toLowerCase();
        this.activeNarratives.set(key, signal);
        this.emit('narrativeDetected', signal);
        console.log(
          `📢 [NarrativeRadar] 🔥 ${theme} velocity=${signal.velocity} keywords=${signal.keywords.slice(0, 5).join(',')}`,
        );
      }

      // Drop stale (> 30 min)
      const cutoff = now - 30 * 60_000;
      for (const [k, s] of this.activeNarratives) {
        if (s.detectedAt < cutoff) this.activeNarratives.delete(k);
      }

      while (this.activeNarratives.size > this.MAX_NARRATIVES) {
        const oldest = [...this.activeNarratives.entries()].sort((a, b) => a[1].detectedAt - b[1].detectedAt)[0];
        if (oldest) this.activeNarratives.delete(oldest[0]);
        else break;
      }
    } catch {
      /* silent */
    } finally {
      this.scanning = false;
    }
  }

  matchesToken(name: string, symbol: string): NarrativeSignal | null {
    const n = name.toLowerCase();
    const sym = symbol.replace(/^\$/, '').toUpperCase();

    for (const sig of this.activeNarratives.values()) {
      for (const kw of sig.keywords) {
        if (kw && n.includes(kw)) return sig;
      }
      for (const t of sig.tickers) {
        const clean = t.replace(/^\$/, '').toUpperCase();
        if (clean && sym === clean) return sig;
      }
    }
    return null;
  }

  getActiveNarratives(): NarrativeSignal[] {
    return [...this.activeNarratives.values()];
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

export function getNarrativeRadar(): NarrativeRadar {
  if (!singleton) singleton = new NarrativeRadar();
  return singleton;
}
