import Redis from 'ioredis';
import type { SocialSignal } from '../types/index.js';

/**
 * SocialPulse - Détection de signaux sociaux X (Twitter) pour tokens Solana
 * 
 * Features:
 * - Surveillance en temps réel des mentions de tokens
 * - Cache Redis pour authorTrustScore (évite recalcul)
 * - Détection de botnets : 5+ comptes similaires en < 2s
 * - Calcul de velocity (mentions/30s) et sentiment
 */

interface TweetMention {
  authorId: string;
  authorName: string;
  followerCount: number;
  timestamp: number; // Unix timestamp (ms)
  sentiment: number; // -1 à 1
}

interface BotnetCheckResult {
  isBotnet: boolean;
  similarityCount: number;
  penaltyFactor: number; // 0.1 à 1.0
}

export class SocialPulse {
  private redis: Redis;
  private mentions: Map<string, TweetMention[]>; // mint -> mentions
  private readonly BOTNET_THRESHOLD = 5;
  private readonly BOTNET_WINDOW_MS = 2000; // 2 secondes
  private readonly VELOCITY_WINDOW_MS = 30000; // 30 secondes
  private readonly CACHE_TTL = 3600; // 1 heure pour authorTrustScore
  private readonly MENTION_TTL_MS = 60000; // Garde les mentions 1 minute

  constructor(redisUrl: string = 'redis://localhost:6379') {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy: (times) => {
        if (times > 3) return null; // Arrête après 3 tentatives
        return Math.min(times * 50, 500); // Backoff exponentiel
      },
    });
    this.mentions = new Map();

    // Nettoyage automatique des anciennes mentions (optimisation mémoire)
    setInterval(() => this.cleanupOldMentions(), 60000);
  }

  /**
   * Connecte Redis au démarrage
   */
  async connect(): Promise<void> {
    try {
      await this.redis.connect();
      console.log('[SocialPulse] Redis connecté');
    } catch (error) {
      console.error('[SocialPulse] Erreur connexion Redis:', error);
      throw error;
    }
  }

  /**
   * Déconnecte proprement
   */
  async disconnect(): Promise<void> {
    await this.redis.quit();
    this.mentions.clear();
  }

  /**
   * Point d'entrée principal : récupère un signal social pour un mint
   * 
   * @param mint - Adresse du token Solana
   * @returns SocialSignal avec score de hype, velocity, sentiment
   */
  async getSignal(mint: string): Promise<SocialSignal | null> {
    const mintMentions = this.mentions.get(mint) || [];
    
    if (mintMentions.length === 0) {
      return null; // Aucune mention récente
    }

    const now = Date.now();
    const recentMentions = mintMentions.filter(
      (m) => now - m.timestamp < this.VELOCITY_WINDOW_MS
    );

    if (recentMentions.length === 0) {
      return null;
    }

    // Calcul de la vélocité (mentions/30s)
    const velocity30s = recentMentions.length;

    // Calcul du sentiment moyen
    const avgSentiment = recentMentions.reduce((sum, m) => sum + m.sentiment, 0) / recentMentions.length;

    // Détection de botnet
    const botnetCheck = this.detectBotnet(recentMentions);
    
    // Calcul du trust score agrégé
    const trustScore = await this.calculateAggregatedTrustScore(
      recentMentions,
      botnetCheck.penaltyFactor
    );

    // Extraction du follower count moyen
    const avgFollowerCount = Math.floor(
      recentMentions.reduce((sum, m) => sum + m.followerCount, 0) / recentMentions.length
    );

    // Ticker extrait du premier tweet (pour simulation, en prod utiliser API X)
    const ticker = this.extractTickerFromMint(mint);

    return {
      mint,
      ticker,
      platform: 'X',
      authorTrustScore: trustScore,
      followerCount: avgFollowerCount,
      velocity30s,
      sentiment: avgSentiment,
    };
  }

  /**
   * Simule l'ajout d'une mention de tweet (en prod, connecter à X API v2 stream)
   * 
   * @param mint - Token mentionné
   * @param mention - Données du tweet
   */
  addMention(mint: string, mention: TweetMention): void {
    if (!this.mentions.has(mint)) {
      this.mentions.set(mint, []);
    }
    this.mentions.get(mint)!.push(mention);

    // Limite la taille mémoire (garde max 100 mentions par mint)
    const mintMentions = this.mentions.get(mint)!;
    if (mintMentions.length > 100) {
      mintMentions.shift(); // Remove oldest
    }
  }

  /**
   * Détecte si un groupe de mentions provient d'un botnet
   * 
   * Critère: 5+ comptes avec des noms similaires en < 2s
   * 
   * @param mentions - Liste des mentions récentes
   * @returns Résultat avec penalty factor (0.1 si botnet détecté, 1.0 sinon)
   */
  private detectBotnet(mentions: TweetMention[]): BotnetCheckResult {
    if (mentions.length < this.BOTNET_THRESHOLD) {
      return { isBotnet: false, similarityCount: 0, penaltyFactor: 1.0 };
    }

    const now = Date.now();
    const recentWindow = mentions.filter(
      (m) => now - m.timestamp < this.BOTNET_WINDOW_MS
    );

    if (recentWindow.length < this.BOTNET_THRESHOLD) {
      return { isBotnet: false, similarityCount: 0, penaltyFactor: 1.0 };
    }

    // Détection de similarité des noms (simple: prefixe commun de 5+ chars)
    const names = recentWindow.map((m) => m.authorName.toLowerCase());
    const similarGroups = this.findSimilarNames(names);

    const maxSimilarGroup = Math.max(...similarGroups.map((g) => g.length));

    if (maxSimilarGroup >= this.BOTNET_THRESHOLD) {
      console.warn(`[SocialPulse] ⚠️ BOTNET détecté: ${maxSimilarGroup} comptes similaires`);
      return {
        isBotnet: true,
        similarityCount: maxSimilarGroup,
        penaltyFactor: 0.1, // Baisse drastique du score
      };
    }

    return { isBotnet: false, similarityCount: 0, penaltyFactor: 1.0 };
  }

  /**
   * Trouve les groupes de noms similaires (préfixe commun de 5+ chars)
   * 
   * @param names - Liste des noms d'auteurs
   * @returns Groupes de noms similaires
   */
  private findSimilarNames(names: string[]): string[][] {
    const groups: Map<string, string[]> = new Map();

    for (const name of names) {
      const prefix = name.slice(0, 5); // Utilise les 5 premiers caractères
      if (!groups.has(prefix)) {
        groups.set(prefix, []);
      }
      groups.get(prefix)!.push(name);
    }

    return Array.from(groups.values()).filter((g) => g.length > 1);
  }

  /**
   * Calcule le score de confiance agrégé avec cache Redis
   * 
   * Utilise une moyenne pondérée par le nombre de followers.
   * Cache les scores individuels dans Redis (TTL 1h).
   * 
   * @param mentions - Mentions récentes
   * @param botnetPenalty - Facteur de pénalité si botnet détecté
   * @returns Score de 0 à 100
   */
  private async calculateAggregatedTrustScore(
    mentions: TweetMention[],
    botnetPenalty: number
  ): Promise<number> {
    let weightedSum = 0;
    let totalWeight = 0;

    for (const mention of mentions) {
      const trustScore = await this.getAuthorTrustScore(
        mention.authorId,
        mention.followerCount
      );

      // Pondération par followers (log scale pour éviter domination des gros comptes)
      const weight = Math.log10(mention.followerCount + 10); // +10 pour éviter log(0)
      
      weightedSum += trustScore * weight;
      totalWeight += weight;
    }

    const avgTrust = totalWeight > 0 ? weightedSum / totalWeight : 0;

    // Application de la pénalité botnet
    return Math.max(0, Math.min(100, avgTrust * botnetPenalty));
  }

  /**
   * Récupère le trust score d'un auteur depuis Redis (ou calcule si absent)
   * 
   * @param authorId - ID de l'auteur X
   * @param followerCount - Nombre de followers
   * @returns Trust score (0-100)
   */
  private async getAuthorTrustScore(
    authorId: string,
    followerCount: number
  ): Promise<number> {
    const cacheKey = `socialpulse:trust:${authorId}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) {
        return parseFloat(cached);
      }

      // Calcul du score de confiance (heuristique simple)
      // En production: utiliser historique des performances de cet auteur
      const baseTrust = this.calculateBaseTrustScore(followerCount);

      // Cache pour 1h
      await this.redis.setex(cacheKey, this.CACHE_TTL, baseTrust.toString());

      return baseTrust;
    } catch (error) {
      console.error('[SocialPulse] Erreur Redis get/set:', error);
      // Fallback: calcul sans cache
      return this.calculateBaseTrustScore(followerCount);
    }
  }

  /**
   * Calcule un score de confiance de base selon les followers
   * 
   * Heuristique:
   * - < 100 followers: 10-30
   * - 100-1k: 30-50
   * - 1k-10k: 50-70
   * - 10k-100k: 70-85
   * - > 100k: 85-95
   * 
   * @param followerCount - Nombre de followers
   * @returns Score de 0 à 100
   */
  private calculateBaseTrustScore(followerCount: number): number {
    if (followerCount < 100) {
      return 10 + (followerCount / 100) * 20; // 10-30
    } else if (followerCount < 1000) {
      return 30 + ((followerCount - 100) / 900) * 20; // 30-50
    } else if (followerCount < 10000) {
      return 50 + ((followerCount - 1000) / 9000) * 20; // 50-70
    } else if (followerCount < 100000) {
      return 70 + ((followerCount - 10000) / 90000) * 15; // 70-85
    } else {
      return Math.min(95, 85 + Math.log10(followerCount - 100000 + 1) * 2); // 85-95
    }
  }

  /**
   * Nettoie les mentions anciennes (> 1 minute) pour optimiser la mémoire
   */
  private cleanupOldMentions(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [mint, mentions] of this.mentions.entries()) {
      const filtered = mentions.filter(
        (m) => now - m.timestamp < this.MENTION_TTL_MS
      );

      if (filtered.length === 0) {
        this.mentions.delete(mint);
        cleaned++;
      } else if (filtered.length < mentions.length) {
        this.mentions.set(mint, filtered);
      }
    }

    if (cleaned > 0) {
      console.log(`[SocialPulse] 🧹 Nettoyé ${cleaned} mints sans mentions récentes`);
    }
  }

  /**
   * Extrait un ticker simulé depuis le mint (en prod, utiliser Metaplex/API)
   * 
   * @param mint - Adresse du token
   * @returns Ticker (4 premiers chars du mint pour simulation)
   */
  private extractTickerFromMint(mint: string): string {
    return mint.slice(0, 4).toUpperCase();
  }

  /**
   * Statistiques pour monitoring
   */
  getStats() {
    let totalMentions = 0;
    for (const mentions of this.mentions.values()) {
      totalMentions += mentions.length;
    }

    return {
      trackedMints: this.mentions.size,
      totalMentions,
      redisConnected: this.redis.status === 'ready',
    };
  }
}
