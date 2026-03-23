/**
 * Narrative Radar (P2) — Grok + `web_search` (xAI Responses, équivalent live X vs ancien x_search client).
 * Étape 1 : scan ~2 min, JSON thèmes / vélocité / tickers (+ Reddit/Telegram si la recherche les remonte).
 * Étape 2 : matcher courbes COLD/WARM → force HOT (CurveTracker).
 * Étape 3 : pre-alert watchlist si pas de courbe → prochains mints Pump.fun en WARM + `narrativeMatch`.
 */

import { EventEmitter } from 'events';
import { XAI_RESPONSES_WEB_TOOLS } from './xai-live-search.js';
import { getCurveTracker } from '../modules/curve-tracker/CurveTracker.js';
import type { TrackedCurve } from '../types/bonding-curve.js';

function narrativeResponsesTimeoutMs(): number {
  const v = process.env.XAI_RESPONSES_TIMEOUT_MS;
  if (v === undefined || v === '') return 120_000;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 15_000 ? n : 120_000;
}

function narrativeMinVelocity(): number {
  const v = process.env.NARRATIVE_MIN_VELOCITY;
  if (v === undefined || v === '') return 4;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : 4;
}

const NARRATIVE_WATCHLIST_TTL_MS = parseInt(process.env.NARRATIVE_WATCHLIST_TTL_MS ?? `${45 * 60_000}`, 10) || 45 * 60_000;
const MAX_NARRATIVE_WATCHLIST = Math.max(5, parseInt(process.env.NARRATIVE_WATCHLIST_MAX ?? '40', 10) || 40);

export interface NarrativeSignal {
  theme: string;
  /** 1–10 intensité globale du buzz */
  velocity: number;
  /** 1–10 pic de répétitions / spam du même ticker ou meme (ex. FLOKI multi-posts) */
  mentionSpike: number;
  /** Ton dominant ou changement récent (ex. rising_fomo, euphoric, panic, neutral) */
  toneShift: string;
  /** Nombre approximatif de signaux depuis comptes vérifiés / gros KOL (estimation modèle) */
  verifiedSignals: number;
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

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
}

/** Évite les faux positifs (ex. "sol" dans chaque nom de token). */
const NARRATIVE_KEYWORD_STOP = new Set([
  'sol',
  'solana',
  'meme',
  'coin',
  'token',
  'pump',
  'fun',
  'new',
  'the',
  'and',
  'for',
  'moon',
  'gem',
]);

let singleton: NarrativeRadar | null = null;

export class NarrativeRadar extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly SCAN_MS: number;
  private readonly activeNarratives = new Map<string, NarrativeSignal>();
  /** Pre-alert : narratifs trending sans courbe trackée — match sur prochains mints Pump.fun. */
  private readonly narrativeWatchlist = new Map<
    string,
    { signal: NarrativeSignal; expiresAt: number }
  >();
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

  /**
   * Étape 3 — nouveau mint : si nom/symbole matche la watchlist pre-alert, réinjecte le signal
   * dans `activeNarratives` pour le boost social ; l’appelant enregistre la courbe en WARM (skip COLD).
   */
  takeWatchlistMatchForNewMint(name: string, symbol: string): NarrativeSignal | null {
    const now = Date.now();
    this.pruneNarrativeWatchlist(now);
    let best: NarrativeSignal | null = null;
    let bestSc = -1;
    for (const { signal } of this.narrativeWatchlist.values()) {
      if (!this.tokenMatchesSignal(name, symbol, signal)) continue;
      const sc = this.narrativeStrength(signal);
      if (sc > bestSc) {
        bestSc = sc;
        best = signal;
      }
    }
    if (best) {
      this.activeNarratives.set(best.theme.toLowerCase(), { ...best, detectedAt: now });
      console.log(
        `📋 [NarrativeRadar] Watchlist hit → "${best.theme}" for "${name.slice(0, 32)}${name.length > 32 ? '…' : ''}" / $${symbol}`,
      );
    }
    return best;
  }

  getWatchlistSize(): number {
    this.pruneNarrativeWatchlist(Date.now());
    return this.narrativeWatchlist.size;
  }

  private pruneNarrativeWatchlist(now: number): void {
    for (const [k, v] of this.narrativeWatchlist) {
      if (v.expiresAt < now) this.narrativeWatchlist.delete(k);
    }
  }

  private addNarrativeToWatchlist(signal: NarrativeSignal): void {
    const now = Date.now();
    this.pruneNarrativeWatchlist(now);
    while (this.narrativeWatchlist.size >= MAX_NARRATIVE_WATCHLIST) {
      const oldest = [...this.narrativeWatchlist.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest) this.narrativeWatchlist.delete(oldest[0]);
      else break;
    }
    const key = signal.theme.toLowerCase();
    this.narrativeWatchlist.set(key, {
      signal: { ...signal, detectedAt: now },
      expiresAt: now + NARRATIVE_WATCHLIST_TTL_MS,
    });
    console.log(
      `📋 [NarrativeRadar] Watchlist + "${signal.theme}" (TTL ${Math.round(NARRATIVE_WATCHLIST_TTL_MS / 60_000)}min)`,
    );
  }

  private narrativeStrength(sig: NarrativeSignal): number {
    return (
      sig.velocity +
      sig.mentionSpike * 0.55 +
      Math.min(10, sig.verifiedSignals) * 0.25 +
      sig.confidence * 3
    );
  }

  /** Matching explicite token ↔ un seul signal (pre-alert, tests). */
  tokenMatchesSignal(name: string, symbol: string, sig: NarrativeSignal): boolean {
    const n = normalizeName(name).replace(/\s+/g, ' ').trim();
    const sym = symbol.replace(/^\$/, '').toUpperCase();

    for (const t of sig.tickers) {
      const clean = t.replace(/^\$/, '').toUpperCase();
      if (clean && sym === clean) return true;
    }
    for (const kw of sig.keywords) {
      const k = kw.toLowerCase();
      if (k.length < 3 || NARRATIVE_KEYWORD_STOP.has(k)) continue;
      if (n.includes(k)) return true;
    }
    const tl = sig.theme.toLowerCase();
    if (tl.length >= 3 && n.includes(tl)) return true;
    for (const w of tl.split(/[^a-z0-9]+/)) {
      if (w.length >= 4 && n.includes(w)) return true;
    }
    return false;
  }

  matchesToken(name: string, symbol: string): NarrativeSignal | null {
    let best: NarrativeSignal | null = null;
    let bestScore = -1;
    for (const sig of this.activeNarratives.values()) {
      if (!this.tokenMatchesSignal(name, symbol, sig)) continue;
      const sc = this.narrativeStrength(sig);
      if (sc > bestScore) {
        bestScore = sc;
        best = sig;
      }
    }
    return best;
  }

  private promoteMatchingCurves(): void {
    try {
      const curves = getCurveTracker().getAllTrackedCurves();
      for (const c of curves) {
        if (c.tier === 'hot') continue;
        const m = c.metadata ?? {};
        const sig = this.matchesToken(m.name ?? '', m.symbol ?? '');
        if (sig) {
          getCurveTracker().forcePromoteHot(c.mint);
          console.log(
            `📡 [NarrativeRadar] HOT promote ${c.mint.slice(0, 8)}… (${c.tier}) ← "${sig.theme}" (Étape 2 matcher)`,
          );
        }
      }
    } catch {
      /* CurveTracker peut être absent hors curve-prediction */
    }
  }

  private async scanTrends(): Promise<void> {
    if (!this.apiKey || this.scanning) return;
    this.scanning = true;
    try {
      this.pruneNarrativeWatchlist(Date.now());

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
                'You scan live social data (X first; note Reddit crypto subs or Telegram crypto channels only if your search surfaces them). ' +
                'Classify sentiment and flag narrative inflections (FOMO spike, panic, skeptical rotation) BEFORE they fully show in price charts. ' +
                'Detect: (1) burst of repeated ticker/meme mentions; (2) coordinated-looking pushes from verified or large accounts; ' +
                '(3) emotional tone shifts. Use ONLY evidence from the LAST ~30 MINUTES. Return ONLY a JSON array, no markdown.',
            },
            {
              role: 'user',
              content:
                'Quels memes, narratifs ou tickers crypto émergent sur X dans les ~30 dernières minutes ? ' +
                'Focus : Solana, Pump.fun, memecoins. Si pertinent, indique si le même thème apparaît sur Reddit ou Telegram. ' +
                'Pour chaque tendance, UN objet JSON : theme (label court), velocity 1-10 (vélocité des mentions), ' +
                'mentionSpike 1-10 (répétitions / pic soudain), toneShift (ex. rising_fomo, euphoric, neutral, panic, skeptical), ' +
                'verifiedSignals 0-50 (estimation comptes vérifiés / KOL notables), keywords minuscules, tickers style $PEPE, ' +
                'contractAddresses (mints Solana si connus), confidence 0-1. ' +
                'Exemple : [{"theme":"...","velocity":7,"mentionSpike":8,"toneShift":"rising_fomo","verifiedSignals":4,"keywords":["pepe"],"tickers":["$PEPE"],"contractAddresses":[],"confidence":0.7}]',
            },
          ],
          max_output_tokens: 2048,
        }),
        signal: AbortSignal.timeout(narrativeResponsesTimeoutMs()),
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

      const minV = narrativeMinVelocity();
      const now = Date.now();
      let curves: TrackedCurve[] = [];
      try {
        curves = getCurveTracker().getAllTrackedCurves();
      } catch {
        curves = [];
      }

      for (const raw of items) {
        if (typeof raw !== 'object' || raw === null) continue;
        const o = raw as Record<string, unknown>;
        const theme = String(o.theme ?? '').trim();
        const velocity = Number(o.velocity) || 0;
        const mentionSpike = Math.max(0, Math.min(10, Number(o.mentionSpike) || 0));
        const verifiedSignals = Math.max(0, Math.min(50, Number(o.verifiedSignals) || 0));
        const passesGate =
          velocity >= minV ||
          mentionSpike >= 7 ||
          verifiedSignals >= 5 ||
          (mentionSpike >= 5 && verifiedSignals >= 3);
        if (!theme || !passesGate) continue;

        const toneRaw = o.toneShift;
        const toneShift =
          typeof toneRaw === 'string' && toneRaw.trim() ? toneRaw.trim().slice(0, 48) : 'neutral';

        const signal: NarrativeSignal = {
          theme,
          velocity: Math.max(1, Math.min(10, velocity || 1)),
          mentionSpike: mentionSpike || Math.min(10, Math.round(velocity * 0.8)),
          toneShift,
          verifiedSignals,
          keywords: Array.isArray(o.keywords)
            ? (o.keywords as string[]).map((s) => String(s).toLowerCase().trim()).filter(Boolean)
            : [],
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
          `📢 [NarrativeRadar] 🔥 ${theme} v=${signal.velocity} spike=${signal.mentionSpike} tone=${signal.toneShift} verified≈${signal.verifiedSignals} kw=${signal.keywords.slice(0, 4).join(',')}`,
        );

        const matchedCurve = curves.some((c) =>
          this.tokenMatchesSignal(c.metadata?.name ?? '', c.metadata?.symbol ?? '', signal),
        );
        if (
          !matchedCurve &&
          (signal.velocity >= 6 || signal.mentionSpike >= 6 || signal.verifiedSignals >= 4)
        ) {
          this.addNarrativeToWatchlist(signal);
        }
      }

      this.promoteMatchingCurves();

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
      /* silent — event loop */
    } finally {
      this.scanning = false;
    }
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
