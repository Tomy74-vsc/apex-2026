/**
 * TelegramTokenScanner — M5 / Phase C
 * 1) Lien TG : DexScreener + URI metadata
 * 2) Score : GramJS + NLPPipeline si client dispo ; sinon proxy **gratuit** Dex (txns h1) pour ne pas perdre le slot social.
 */

import type { TelegramClient } from 'telegram';
import type { EntityLike } from 'telegram/define.js';
import { getNLPPipeline } from '../nlp/NLPPipeline.js';

const DEX_TOKEN_URL = 'https://api.dexscreener.com/latest/dex/tokens';
const DEX_TIMEOUT_MS = 3_000;
const META_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_SCANS = 5;
const HISTORY_THROTTLE_MS = 3_000;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_MESSAGES_NLP = 18;
const RED_FLAG = /\b(rug|scam|honeypot|dump\s+it|sell\s+now|dev\s+sold)\b/i;

export type TelegramTokenScanSource = 'telegram_live' | 'dex_proxy' | 'none';

export interface TelegramTokenScanResult {
  telegramUrl: string | null;
  compositeScore: number;
  avgSentiment: number;
  messagesPerMinute: number;
  memberCount: number;
  redFlagCount: number;
  analyzedAt: number;
  source: TelegramTokenScanSource;
  /** Tx Solana agrégées (1h) sur les pairs Dex — feature ML / debug */
  dexH1TxCount: number;
}

interface DexPair {
  chainId?: string;
  info?: {
    socials?: Array<{ type?: string; url?: string }>;
  };
  txns?: {
    h1?: { buys?: number; sells?: number };
    m5?: { buys?: number; sells?: number };
  };
}

function extractPublicTgHandle(rawUrl: string): string | null {
  const u = rawUrl.trim();
  if (u.includes('/+') || u.includes('joinchat')) return null;
  const m = u.match(/(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([a-zA-Z_][a-zA-Z0-9_]{3,})\/?$/);
  if (m?.[1]) return m[1]!;
  const at = u.match(/^@?([a-zA-Z_][a-zA-Z0-9_]{3,})$/);
  return at?.[1] ?? null;
}

function findTelegramUrlInSocials(
  socials: Array<{ type?: string; url?: string }> | undefined,
): string | null {
  if (!socials?.length) return null;
  for (const s of socials) {
    const t = (s.type ?? '').toLowerCase();
    if ((t === 'telegram' || t === 'tg') && s.url) {
      const h = extractPublicTgHandle(s.url);
      if (h) return s.url;
    }
  }
  for (const s of socials) {
    if (!s.url) continue;
    if (/t\.me|telegram\.me/i.test(s.url)) {
      const h = extractPublicTgHandle(s.url);
      if (h) return s.url;
    }
  }
  return null;
}

/** Un seul fetch DexScreener : lien TG + activité h1 (gratuit, $0 infra). */
async function fetchDexTokenContext(mint: string): Promise<{
  tgUrl: string | null;
  h1TxCount: number;
  m5TxCount: number;
}> {
  try {
    const resp = await fetch(`${DEX_TOKEN_URL}/${mint}`, {
      signal: AbortSignal.timeout(DEX_TIMEOUT_MS),
    });
    if (!resp.ok) return { tgUrl: null, h1TxCount: 0, m5TxCount: 0 };
    const data = (await resp.json()) as { pairs?: DexPair[] };
    const pairs = (data.pairs ?? []).filter((p) => p.chainId === 'solana');
    let tgUrl: string | null = null;
    let h1TxCount = 0;
    let m5TxCount = 0;
    for (const p of pairs) {
      if (!tgUrl) {
        const u = findTelegramUrlInSocials(p.info?.socials);
        if (u) tgUrl = u;
      }
      const h1 = p.txns?.h1;
      h1TxCount = Math.max(h1TxCount, (h1?.buys ?? 0) + (h1?.sells ?? 0));
      const m5 = p.txns?.m5;
      m5TxCount = Math.max(m5TxCount, (m5?.buys ?? 0) + (m5?.sells ?? 0));
    }
    return { tgUrl, h1TxCount, m5TxCount };
  } catch {
    return { tgUrl: null, h1TxCount: 0, m5TxCount: 0 };
  }
}

async function discoverTelegramUrlFromMetadataUri(uri: string | undefined): Promise<string | null> {
  if (!uri || !uri.startsWith('http')) return null;
  try {
    const resp = await fetch(uri, { signal: AbortSignal.timeout(META_TIMEOUT_MS) });
    if (!resp.ok) return null;
    const text = await resp.text();
    const m = text.match(/https?:\/\/(?:t\.me|telegram\.me)\/[a-zA-Z0-9_+/]+/i);
    if (!m?.[0]) return null;
    return extractPublicTgHandle(m[0]) ? m[0] : null;
  } catch {
    return null;
  }
}

/**
 * Proxy social $0 quand GramJS indisponible : activité Dex récente + bonus si lien TG listé.
 */
function compositeFromDexProxy(h1Tx: number, m5Tx: number, hasTelegramListed: boolean): number {
  const h1n = Math.min(1, h1Tx / 45);
  const m5n = Math.min(1, m5Tx / 15);
  const activity = 0.55 * h1n + 0.45 * m5n;
  const listedBoost = hasTelegramListed ? 0.18 : 0;
  return Math.max(0, Math.min(1, activity * 0.82 + listedBoost));
}

function memberCountFromEntity(entity: unknown): number {
  if (
    entity &&
    typeof entity === 'object' &&
    'participantsCount' in entity &&
    typeof (entity as { participantsCount?: number }).participantsCount === 'number'
  ) {
    const n = (entity as { participantsCount: number }).participantsCount;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 200;
}

export class TelegramTokenScanner {
  private activeScans = 0;
  private lastJoinOrHistoryMs = 0;
  private readonly cache = new Map<string, { at: number; result: TelegramTokenScanResult }>();

  /**
   * Analyse TG (live si client) ou proxy Dex gratuit. Ne throw pas.
   */
  async analyzeMint(
    mint: string,
    metadata: { name?: string; symbol?: string; uri?: string },
    client: TelegramClient | null,
  ): Promise<TelegramTokenScanResult> {
    const t0 = performance.now();

    const cached = this.cache.get(mint);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.result;
    }

    while (this.activeScans >= MAX_CONCURRENT_SCANS) {
      await new Promise((r) => setTimeout(r, 200));
    }
    this.activeScans++;
    try {
      const dexCtx = await fetchDexTokenContext(mint);
      let tgUrl = dexCtx.tgUrl;
      if (!tgUrl && metadata.uri) {
        tgUrl = await discoverTelegramUrlFromMetadataUri(metadata.uri);
      }

      const hasTgListed = tgUrl != null;
      const dexH1 = dexCtx.h1TxCount;
      const dexM5 = dexCtx.m5TxCount;

      if (!client) {
        const composite = hasTgListed || dexH1 > 0 || dexM5 > 0
          ? compositeFromDexProxy(dexH1, dexM5, hasTgListed)
          : 0;
        const result: TelegramTokenScanResult = {
          telegramUrl: tgUrl,
          compositeScore: composite,
          avgSentiment: 0,
          messagesPerMinute: 0,
          memberCount: 0,
          redFlagCount: 0,
          analyzedAt: Date.now(),
          source: composite > 0 ? 'dex_proxy' : 'none',
          dexH1TxCount: dexH1,
        };
        this.cache.set(mint, { at: Date.now(), result });
        if (composite > 0) {
          console.log(
            `📱 [TelegramTokenScanner] ${mint.slice(0, 8)}… dex_proxy score=${composite.toFixed(2)} ` +
              `h1tx=${dexH1} m5tx=${dexM5} tgListed=${hasTgListed} ⏱️${(performance.now() - t0).toFixed(0)}ms`,
          );
        }
        return result;
      }

      if (!tgUrl) {
        const composite = compositeFromDexProxy(dexH1, dexM5, false);
        const result: TelegramTokenScanResult = {
          telegramUrl: null,
          compositeScore: composite,
          avgSentiment: 0,
          messagesPerMinute: 0,
          memberCount: 0,
          redFlagCount: 0,
          analyzedAt: Date.now(),
          source: composite > 0 ? 'dex_proxy' : 'none',
          dexH1TxCount: dexH1,
        };
        this.cache.set(mint, { at: Date.now(), result });
        return result;
      }

      const handle = extractPublicTgHandle(tgUrl);
      if (!handle) {
        const composite = compositeFromDexProxy(dexH1, dexM5, true);
        const result: TelegramTokenScanResult = {
          telegramUrl: tgUrl,
          compositeScore: composite,
          avgSentiment: 0,
          messagesPerMinute: 0,
          memberCount: 0,
          redFlagCount: 0,
          analyzedAt: Date.now(),
          source: 'dex_proxy',
          dexH1TxCount: dexH1,
        };
        this.cache.set(mint, { at: Date.now(), result });
        return result;
      }

      const now = Date.now();
      if (now - this.lastJoinOrHistoryMs < HISTORY_THROTTLE_MS) {
        await new Promise((r) => setTimeout(r, HISTORY_THROTTLE_MS - (now - this.lastJoinOrHistoryMs)));
      }
      this.lastJoinOrHistoryMs = Date.now();

      let entity: EntityLike;
      try {
        entity = await client.getEntity(handle);
      } catch {
        const composite = compositeFromDexProxy(dexH1, dexM5, true);
        console.log(
          `📱 [TelegramTokenScanner] ⚠️ getEntity ${handle} → dex_proxy ⏱️${(performance.now() - t0).toFixed(0)}ms`,
        );
        const result: TelegramTokenScanResult = {
          telegramUrl: tgUrl,
          compositeScore: composite,
          avgSentiment: 0,
          messagesPerMinute: 0,
          memberCount: 0,
          redFlagCount: 0,
          analyzedAt: Date.now(),
          source: 'dex_proxy',
          dexH1TxCount: dexH1,
        };
        this.cache.set(mint, { at: Date.now(), result });
        return result;
      }

      const memberCount = memberCountFromEntity(entity);
      const reach = Math.max(50, Math.min(500_000, memberCount));

      const texts: { body: string; tsMs: number }[] = [];
      const fiveMinAgo = Date.now() - 5 * 60_000;

      try {
        for await (const msg of client.iterMessages(entity, { limit: 80 })) {
          const body = msg.text ? String(msg.text) : '';
          if (!body.trim()) continue;
          const tsMs =
            typeof (msg as { date?: number }).date === 'number'
              ? (msg as { date: number }).date * 1000
              : Date.now();
          texts.push({ body, tsMs });
        }
      } catch (e) {
        console.log(
          `📱 [TelegramTokenScanner] ⚠️ iterMessages ${handle}: ${(e as Error).message?.slice(0, 60)}`,
        );
      }

      const recent = texts.filter((x) => x.tsMs >= fiveMinAgo);
      const messagesPerMinute = recent.length / 5;

      if (texts.length === 0) {
        const composite = compositeFromDexProxy(dexH1, dexM5, true);
        const result: TelegramTokenScanResult = {
          telegramUrl: tgUrl,
          compositeScore: composite,
          avgSentiment: 0,
          messagesPerMinute: 0,
          memberCount,
          redFlagCount: 0,
          analyzedAt: Date.now(),
          source: 'dex_proxy',
          dexH1TxCount: dexH1,
        };
        this.cache.set(mint, { at: Date.now(), result });
        console.log(
          `📱 [TelegramTokenScanner] ${mint.slice(0, 8)}… @${handle} no msgs → dex_proxy=${composite.toFixed(2)} ⏱️${(performance.now() - t0).toFixed(0)}ms`,
        );
        return result;
      }

      const nlp = getNLPPipeline();
      const sentiments: number[] = [];
      let redFlagCount = 0;

      const slice = texts.slice(0, MAX_MESSAGES_NLP);
      for (const { body } of slice) {
        if (RED_FLAG.test(body)) redFlagCount++;
        try {
          const sig = await nlp.process(body, mint, 'Telegram', 55, reach);
          if (sig.category !== 'SPAM') {
            sentiments.push(sig.sentiment);
          }
        } catch {
          /* cold path */
        }
        await new Promise((r) => setTimeout(r, 40));
      }

      const avgSentiment =
        sentiments.length > 0 ? sentiments.reduce((a, b) => a + b, 0) / sentiments.length : 0;

      const sentiment01 = (avgSentiment + 1) / 2;
      const activity01 = Math.min(1, messagesPerMinute / 4);
      const members01 = Math.min(1, memberCount / 5_000);
      let composite = 0.45 * sentiment01 + 0.35 * activity01 + 0.2 * members01;

      if (redFlagCount >= 3) {
        composite = 0;
      } else if (memberCount < 10) {
        composite *= 0.3;
      }

      composite = Math.max(0, Math.min(1, composite));

      const result: TelegramTokenScanResult = {
        telegramUrl: tgUrl,
        compositeScore: composite,
        avgSentiment,
        messagesPerMinute,
        memberCount,
        redFlagCount,
        analyzedAt: Date.now(),
        source: 'telegram_live',
        dexH1TxCount: dexH1,
      };

      this.cache.set(mint, { at: Date.now(), result });
      console.log(
        `📱 [TelegramTokenScanner] ${mint.slice(0, 8)}… @${handle} score=${composite.toFixed(2)} ` +
          `mpm=${messagesPerMinute.toFixed(2)} red=${redFlagCount} ⏱️${(performance.now() - t0).toFixed(0)}ms`,
      );
      return result;
    } finally {
      this.activeScans = Math.max(0, this.activeScans - 1);
    }
  }
}

let _scanner: TelegramTokenScanner | null = null;

export function getTelegramTokenScanner(): TelegramTokenScanner {
  if (!_scanner) _scanner = new TelegramTokenScanner();
  return _scanner;
}
