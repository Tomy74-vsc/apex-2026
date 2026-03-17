import { EventEmitter } from 'events';
import { MarketScanner } from '../ingestors/MarketScanner.js';
import { Guard } from '../detectors/Guard.js';
import { SocialPulse } from '../ingestors/SocialPulse.js';
import type {
  MarketEvent,
  SecurityReport,
  ScoredToken,
  SocialSignal,
  DecisionLatency,
} from '../types/index.js';

/**
 * Événements émis par le DecisionCore
 */
export interface DecisionCoreEvents {
  'tokenDetected': (mint: string) => void;
  'tokenScored': (token: ScoredToken) => void;
  'readyToSnipe': (token: ScoredToken) => void;
  'tokenRejected': (mint: string, reason: string) => void;
}

/**
 * Options de configuration pour le DecisionCore
 */
export interface DecisionCoreOptions {
  minLiquidity?: number; // Liquidité minimale en SOL (défaut: 5)
  maxRiskScore?: number; // Score de risque max acceptable (défaut: 50)
  fastCheckThreshold?: number; // Threshold pour FastCheck (défaut: 100 SOL)
  enableFastCheck?: boolean; // Active/désactive FastCheck (défaut: true)
  socialPulse?: SocialPulse; // Instance de SocialPulse pour signaux sociaux
}

/**
 * DecisionCore - Moteur de décision pour le trading HFT
 * 
 * Reçoit les événements du MarketScanner, analyse via Guard,
 * calcule un score final et décide d'exécuter ou non le trade.
 */
export class DecisionCore extends EventEmitter {
  private scanner: MarketScanner;
  private guard: Guard;
  private socialPulse: SocialPulse | null;
  private minLiquidity: number;
  private maxRiskScore: number;
  private enableFastCheck: boolean;
  private tokensProcessed: number = 0;
  private tokensAccepted: number = 0;
  private tokensRejected: number = 0;

  constructor(options: DecisionCoreOptions = {}) {
    super();

    this.minLiquidity = options.minLiquidity || 5;
    this.maxRiskScore = options.maxRiskScore || 50;
    this.enableFastCheck = options.enableFastCheck !== false;
    this.socialPulse = options.socialPulse || null;

    // Initialise les composants
    this.scanner = new MarketScanner({
      fastCheckThreshold: options.fastCheckThreshold || 100,
    });

    this.guard = new Guard();

    // Configure les événements du scanner
    this.setupScannerEvents();
  }

  /**
   * Configure les événements du MarketScanner
   */
  private setupScannerEvents(): void {
    // Événement standard : nouveau token détecté
    this.scanner.on('newToken', async (event: MarketEvent) => {
      this.emit('tokenDetected', event.token.mint);
      await this.processToken(event, false);
    });

    // FastCheck : priorité absolue pour haute liquidité
    if (this.enableFastCheck) {
      this.scanner.on('fastCheck', async (event: MarketEvent) => {
        this.emit('tokenDetected', event.token.mint);
        console.log('⚡ FastCheck déclenché pour:', event.token.mint);
        await this.processToken(event, true);
      });
    }

    // Propagation des événements de connexion
    this.scanner.on('connected', () => {
      console.log('✅ DecisionCore: Scanner connecté');
    });

    this.scanner.on('error', (error: Error) => {
      console.error('❌ DecisionCore: Erreur scanner:', error);
    });
  }

  /**
   * Démarre le DecisionCore
   */
  async start(): Promise<void> {
    console.log('🚀 Démarrage du DecisionCore...');
    console.log(`   - Liquidité min: ${this.minLiquidity} SOL`);
    console.log(`   - Risk score max: ${this.maxRiskScore}`);
    console.log(`   - FastCheck: ${this.enableFastCheck ? 'Activé' : 'Désactivé'}\n`);

    await this.scanner.start();
  }

  /**
   * Arrête le DecisionCore
   */
  async stop(): Promise<void> {
    console.log('🛑 Arrêt du DecisionCore...');
    await this.scanner.stop();
    
    console.log('\n📊 Statistiques finales:');
    console.log(`   - Tokens traités: ${this.tokensProcessed}`);
    console.log(`   - Tokens acceptés: ${this.tokensAccepted}`);
    console.log(`   - Tokens rejetés: ${this.tokensRejected}`);
  }

  /**
   * Traite un MarketEvent externe (depuis PumpScanner ou autres sources)
   * 
   * @param event - Événement MarketEvent
   * @param isFastCheck - True si c'est un FastCheck (priorité absolue)
   */
  async processMarketEvent(event: MarketEvent, isFastCheck: boolean = false): Promise<void> {
    await this.processToken(event, isFastCheck);
  }

  /**
   * Traite un token détecté
   * 
   * @param event - Événement MarketEvent du scanner
   * @param isFastCheck - True si c'est un FastCheck (priorité absolue)
   */
  private async processToken(event: MarketEvent, isFastCheck: boolean): Promise<void> {
    this.tokensProcessed++;

    // Fallbacks backward compatible
    const t_source = event.t_source ?? event.timestamp ?? Date.now();
    const t_recv = event.t_recv ?? Date.now();

    try {
      const { token, initialLiquiditySol } = event;

      // Filtre 1 : Liquidité minimale
      if (initialLiquiditySol < this.minLiquidity) {
        this.rejectToken(
          token.mint,
          `Liquidité insuffisante: ${initialLiquiditySol.toFixed(2)} SOL`,
        );
        return;
      }

      // Guard — mesure avec performance.now()
      console.log(`🔍 Analyse sécurité: ${token.mint}${isFastCheck ? ' [FAST]' : ''}`);
      const guardStart = performance.now();
      const security: SecurityReport = await this.guard.validateToken(token.mint);
      const guardMs = Math.round(performance.now() - guardStart);

      // Filtre 2 : Score de risque
      if (security.riskScore > this.maxRiskScore) {
        this.rejectToken(
          token.mint,
          `Risk score trop élevé: ${security.riskScore} (max: ${this.maxRiskScore})`,
        );
        return;
      }

      // Filtre 3 : Token doit être safe
      if (!security.isSafe) {
        this.rejectToken(token.mint, `Token non sûr: ${security.flags.join(', ')}`);
        return;
      }

      // Récupère les signaux sociaux (si SocialPulse disponible)
      const socialSignal = this.socialPulse
        ? await this.socialPulse.getSignal(token.mint)
        : null;

      // Score — mesure avec performance.now()
      const scoreStart = performance.now();
      const finalScore = this.calculateFinalScore(event, security, socialSignal, isFastCheck);
      const scoringMs = Math.round((performance.now() - scoreStart) * 100) / 100; // 2 décimales

      // t_act : timestamp absolu de la décision
      const t_act = Date.now();
      const totalMs = t_act - t_source;

      // Latences complètes
      const latency: DecisionLatency = {
        detectionMs: Math.max(0, t_recv - t_source),
        guardMs,
        scoringMs,
        totalMs: Math.max(0, totalMs),
      };

      // Log structuré Blueprint V2
      console.log(
        `⏱️  [${token.mint.slice(0, 8)}] detect=${latency.detectionMs}ms | guard=${latency.guardMs}ms | score=${latency.scoringMs}ms | TOTAL=${latency.totalMs}ms`,
      );

      // Détermine la priorité
      const priority = this.determinePriority(finalScore, initialLiquiditySol, isFastCheck);

      // Crée le ScoredToken
      const scoredToken: ScoredToken = {
        ...event,
        t_act,
        social: socialSignal,
        security,
        finalScore,
        priority,
        latency, // nouveau champ optionnel
      };

      // Émet l'événement
      this.emit('tokenScored', scoredToken);

      // Si score suffisant, prêt pour snipe
      if (finalScore >= 70 || (isFastCheck && finalScore >= 60)) {
        this.tokensAccepted++;
        console.log(
          `✅ Token accepté: ${token.mint} (score: ${finalScore}, priorité: ${priority})`,
        );
        this.emit('readyToSnipe', scoredToken);
      } else {
        this.rejectToken(token.mint, `Score insuffisant: ${finalScore}`);
      }
    } catch (error) {
      console.error('❌ Erreur lors du traitement du token:', error);
      this.rejectToken(event.token.mint, `Erreur: ${error}`);
    }
  }

  /**
   * Calcule le score final d'un token
   * 
   * @param event - MarketEvent
   * @param security - SecurityReport du Guard
   * @param socialSignal - SocialSignal de SocialPulse (peut être null)
   * @param isFastCheck - True si FastCheck
   * @returns Score de 0 à 100
   */
  private calculateFinalScore(
    event: MarketEvent,
    security: SecurityReport,
    socialSignal: SocialSignal | null,
    isFastCheck: boolean
  ): number {
    let score = 0;

    // 1. Score de sécurité (40 points max)
    // Inverse du risk score : moins de risque = plus de points
    const securityScore = Math.max(0, 40 - (security.riskScore * 0.4));
    score += securityScore;

    // 2. Score de liquidité (30 points max)
    const liquidityScore = Math.min(30, event.initialLiquiditySol * 0.3);
    score += liquidityScore;

    // 3. Bonus autorités révoquées (15 points)
    if (security.details.mintRenounced && security.details.freezeDisabled) {
      score += 15;
    }

    // 4. Bonus LP burned (10 points)
    if (security.details.lpBurnedPercent > 90) {
      score += 10;
    } else if (security.details.lpBurnedPercent > 50) {
      score += 5;
    }

    // 5. Score social (20 points max si disponible)
    if (socialSignal) {
      // Velocity boost (10 points max)
      const velocityScore = Math.min(10, socialSignal.velocity30s * 0.4);
      score += velocityScore;

      // Trust score boost (5 points max)
      const trustScore = (socialSignal.authorTrustScore / 100) * 5;
      score += trustScore;

      // Sentiment boost (5 points max)
      const sentimentScore = Math.max(0, socialSignal.sentiment * 5);
      score += sentimentScore;
    }

    // 6. Bonus FastCheck (5 points)
    if (isFastCheck) {
      score += 5;
    }

    return Math.min(100, Math.round(score));
  }

  /**
   * Détermine la priorité d'un token
   */
  private determinePriority(
    finalScore: number,
    liquiditySol: number,
    isFastCheck: boolean
  ): 'HIGH' | 'MEDIUM' | 'LOW' {
    if (isFastCheck && finalScore >= 70) {
      return 'HIGH';
    }

    if (finalScore >= 80 || (liquiditySol >= 50 && finalScore >= 70)) {
      return 'HIGH';
    }

    if (finalScore >= 70) {
      return 'MEDIUM';
    }

    return 'LOW';
  }

  /**
   * Rejette un token
   */
  private rejectToken(mint: string, reason: string): void {
    this.tokensRejected++;
    console.log(`❌ Token rejeté: ${mint.slice(0, 8)}... - ${reason}`);
    this.emit('tokenRejected', mint, reason);
  }

  /**
   * Statistiques du DecisionCore
   */
  getStats(): {
    tokensProcessed: number;
    tokensAccepted: number;
    tokensRejected: number;
    acceptanceRate: number;
  } {
    return {
      tokensProcessed: this.tokensProcessed,
      tokensAccepted: this.tokensAccepted,
      tokensRejected: this.tokensRejected,
      acceptanceRate: this.tokensProcessed > 0 
        ? (this.tokensAccepted / this.tokensProcessed) * 100 
        : 0,
    };
  }
}
