/**
 * ViralityScorer — APEX-2026 Phase 2 (P2.1.2)
 *
 * Computes real-time social velocity and virality for token mentions.
 *
 * Velocity:  V(t) = Σ_i w_i × exp(-(t - t_i) / τ_social)
 * Virality:  acceleration of velocity (dV/dt > threshold)
 *
 * Where:
 *   w_i = author trust score × reach weight
 *   t_i = mention timestamp
 *   τ_social = 30s decay constant
 *
 * Detects manipulation: sudden burst followed by silence.
 */

import { EventEmitter } from 'events';

export interface MentionEvent {
  mint: string;
  platform: 'X' | 'Telegram';
  authorTrustScore: number; // 0-100
  reach: number;            // followers/members
  sentiment: number;        // -1 to 1
  timestamp: number;        // Unix ms
}

export interface ViralityResult {
  mint: string;
  velocity: number;         // weighted mentions per τ_social window
  acceleration: number;     // dV/dt — positive = growing
  viralityScore: number;    // 0 to 1 normalized
  mentionCount30s: number;  // raw count in last 30s
  avgSentiment: number;     // weighted sentiment
  isManipulated: boolean;   // burst-then-silence detected
  computedAt: number;
}

const TAU_SOCIAL_MS = 30_000; // τ = 30s decay constant
const MAX_MENTIONS_PER_MINT = 200;
const MANIPULATION_BURST_THRESHOLD = 10; // 10+ mentions in 5s then silence
const MANIPULATION_SILENCE_MS = 15_000;  // 15s silence after burst

export class ViralityScorer extends EventEmitter {
  private mentions: Map<string, MentionEvent[]> = new Map();
  private previousVelocity: Map<string, { v: number; t: number }> = new Map();
  private stats = {
    mentionsReceived: 0,
    computations: 0,
    manipulationsDetected: 0,
  };

  constructor() {
    super();
    console.log('📊 [ViralityScorer] Initialized (τ=30s)');
  }

  /**
   * Record a new mention event.
   */
  addMention(event: MentionEvent): void {
    this.stats.mentionsReceived++;

    const { mint } = event;
    if (!this.mentions.has(mint)) {
      this.mentions.set(mint, []);
    }

    const list = this.mentions.get(mint)!;
    list.push(event);

    // Evict old mentions (> 5 minutes)
    const cutoff = Date.now() - 5 * 60_000;
    while (list.length > 0 && list[0]!.timestamp < cutoff) {
      list.shift();
    }
    if (list.length > MAX_MENTIONS_PER_MINT) {
      list.splice(0, list.length - MAX_MENTIONS_PER_MINT);
    }

    // Emit update
    const result = this.compute(mint);
    if (result) {
      this.emit('viralityUpdate', result);
    }
  }

  /**
   * Compute velocity and virality for a given mint.
   */
  compute(mint: string): ViralityResult | null {
    const list = this.mentions.get(mint);
    if (!list || list.length === 0) return null;

    this.stats.computations++;
    const now = Date.now();

    // Exponential time-decay weighted velocity
    let velocity = 0;
    let weightedSentiment = 0;
    let totalWeight = 0;
    let count30s = 0;

    for (const m of list) {
      const dt = (now - m.timestamp) / TAU_SOCIAL_MS;
      const decay = Math.exp(-dt);

      // Weight = trust × reach (log-scaled) × decay
      const reachWeight = Math.log10(Math.max(10, m.reach));
      const trustWeight = m.authorTrustScore / 100;
      const w = trustWeight * reachWeight * decay;

      velocity += w;
      weightedSentiment += m.sentiment * w;
      totalWeight += w;

      if (now - m.timestamp < TAU_SOCIAL_MS) {
        count30s++;
      }
    }

    const avgSentiment = totalWeight > 0 ? weightedSentiment / totalWeight : 0;

    // Acceleration: compare with previous velocity
    let acceleration = 0;
    const prev = this.previousVelocity.get(mint);
    if (prev && now - prev.t > 0) {
      const dt = (now - prev.t) / 1000; // seconds
      acceleration = (velocity - prev.v) / dt;
    }
    this.previousVelocity.set(mint, { v: velocity, t: now });

    // Virality score: sigmoid of velocity
    const viralityScore = 1 / (1 + Math.exp(-velocity + 3)); // centered at velocity=3

    // Manipulation detection: burst then silence
    const isManipulated = this.detectManipulation(list, now);
    if (isManipulated) this.stats.manipulationsDetected++;

    return {
      mint,
      velocity,
      acceleration,
      viralityScore,
      mentionCount30s: count30s,
      avgSentiment,
      isManipulated,
      computedAt: now,
    };
  }

  /**
   * Quick velocity lookup (returns 0 if unknown). Hot path safe.
   */
  getVelocity(mint: string): number {
    const result = this.compute(mint);
    return result?.velocity ?? 0;
  }

  /**
   * Quick virality score lookup. Hot path safe.
   */
  getViralityScore(mint: string): number {
    const result = this.compute(mint);
    return result?.viralityScore ?? 0;
  }

  /**
   * Detect manipulation pattern: burst followed by silence.
   */
  private detectManipulation(mentions: MentionEvent[], now: number): boolean {
    if (mentions.length < MANIPULATION_BURST_THRESHOLD) return false;

    // Count mentions in 5s windows
    const windows = new Map<number, number>();
    for (const m of mentions) {
      const windowKey = Math.floor(m.timestamp / 5000);
      windows.set(windowKey, (windows.get(windowKey) ?? 0) + 1);
    }

    // Find burst windows
    for (const [windowKey, count] of windows) {
      if (count >= MANIPULATION_BURST_THRESHOLD) {
        const burstEnd = (windowKey + 1) * 5000;
        // Check if silence followed
        const mentionsAfterBurst = mentions.filter(
          (m) => m.timestamp > burstEnd && m.timestamp < burstEnd + MANIPULATION_SILENCE_MS,
        );
        if (mentionsAfterBurst.length <= 1 && now - burstEnd > MANIPULATION_SILENCE_MS) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Clean up stale mints (no mentions in 5 minutes).
   */
  cleanup(): void {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [mint, list] of this.mentions) {
      const latest = list[list.length - 1];
      if (!latest || latest.timestamp < cutoff) {
        this.mentions.delete(mint);
        this.previousVelocity.delete(mint);
      }
    }
  }

  getStats() {
    return { ...this.stats, trackedMints: this.mentions.size };
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _scorer: ViralityScorer | null = null;

export function getViralityScorer(): ViralityScorer {
  if (!_scorer) {
    _scorer = new ViralityScorer();
  }
  return _scorer;
}
