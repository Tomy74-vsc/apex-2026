/**
 * Stage0_Regex — APEX-2026 NLP Pipeline Stage 0 (P2.1.1)
 *
 * Deterministic text cleaning and feature extraction.
 * No API calls — pure regex + lexicon matching.
 * Target latency: < 1ms.
 *
 * Extracts:
 *   - Cleaned text (no URLs, emojis, spam)
 *   - Detected tickers ($SYMBOL)
 *   - Detected Solana addresses
 *   - Spam score (0-1)
 *   - Language (en/other)
 */

export interface Stage0Result {
  cleanedText: string;
  tickers: string[];
  solanaAddresses: string[];
  spamScore: number;     // 0 (clean) to 1 (pure spam)
  hasCallToAction: boolean;
  wordCount: number;
  capsRatio: number;
  emojiCount: number;
  isEnglish: boolean;
}

// Regex patterns
const URL_REGEX = /https?:\/\/[^\s]+/gi;
const TICKER_REGEX = /\$([A-Z]{2,10})\b/g;
const SOLANA_ADDR_REGEX = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
const REPEATED_CHARS_REGEX = /(.)\1{4,}/g;
const EXCESS_WHITESPACE_REGEX = /\s{2,}/g;

// Spam lexicon patterns
const SPAM_PATTERNS = [
  /\b(airdrop|free\s*mint|whitelist|wl\s*spot)\b/i,
  /\b(guaranteed|100x|1000x|moonshot|to\s*the\s*moon)\b/i,
  /\b(join\s*(now|fast|quick)|hurry|last\s*chance|limited)\b/i,
  /\b(dm\s*me|send\s*sol|drop\s*wallet|claim\s*now)\b/i,
  /\b(presale|private\s*sale|early\s*access)\b/i,
  /🚀{3,}|💰{3,}|🔥{3,}/u,
];

// Call-to-action patterns (buying signals)
const CTA_PATTERNS = [
  /\b(buy|ape\s*in|snipe|load\s*up|accumulate|grab)\b/i,
  /\b(dip|entry|undervalued|gem|alpha)\b/i,
  /\b(bullish|pump|rip|send\s*it|LFG)\b/i,
];

// English detection (simple heuristic)
const ENGLISH_WORDS = new Set([
  'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but',
  'in', 'with', 'to', 'for', 'of', 'not', 'this', 'that', 'it',
  'are', 'was', 'be', 'have', 'had', 'has', 'do', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'can',
  'just', 'now', 'new', 'buy', 'sell', 'token', 'price', 'market',
]);

export function processStage0(rawText: string): Stage0Result {
  // Extract before cleaning
  const tickers: string[] = [];
  let match: RegExpExecArray | null;
  const tickerRegex = new RegExp(TICKER_REGEX.source, TICKER_REGEX.flags);
  while ((match = tickerRegex.exec(rawText)) !== null) {
    if (match[1]) tickers.push(match[1]);
  }

  const solanaAddresses = rawText.match(SOLANA_ADDR_REGEX) ?? [];
  const emojiCount = (rawText.match(EMOJI_REGEX) ?? []).length;

  // Clean
  let cleaned = rawText;
  cleaned = cleaned.replace(URL_REGEX, '');
  cleaned = cleaned.replace(EMOJI_REGEX, '');
  cleaned = cleaned.replace(REPEATED_CHARS_REGEX, '$1$1');
  cleaned = cleaned.replace(EXCESS_WHITESPACE_REGEX, ' ').trim();

  // Metrics
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;
  const upperCount = (cleaned.match(/[A-Z]/g) ?? []).length;
  const letterCount = (cleaned.match(/[a-zA-Z]/g) ?? []).length;
  const capsRatio = letterCount > 0 ? upperCount / letterCount : 0;

  // Spam scoring
  let spamHits = 0;
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(rawText)) spamHits++;
  }
  const spamFromPatterns = Math.min(1, spamHits / 3);
  const spamFromCaps = capsRatio > 0.6 ? 0.3 : 0;
  const spamFromEmojis = Math.min(0.3, emojiCount / 20);
  const spamFromShortness = wordCount < 3 ? 0.2 : 0;
  const spamScore = Math.min(1, spamFromPatterns + spamFromCaps + spamFromEmojis + spamFromShortness);

  // CTA detection
  const hasCallToAction = CTA_PATTERNS.some((p) => p.test(rawText));

  // Language detection (simple)
  const lowerWords = words.map((w) => w.toLowerCase());
  const englishHits = lowerWords.filter((w) => ENGLISH_WORDS.has(w)).length;
  const isEnglish = wordCount > 0 ? englishHits / wordCount > 0.15 : true;

  return {
    cleanedText: cleaned,
    tickers: [...new Set(tickers)],
    solanaAddresses: [...new Set(solanaAddresses)],
    spamScore,
    hasCallToAction,
    wordCount,
    capsRatio,
    emojiCount,
    isEnglish,
  };
}
