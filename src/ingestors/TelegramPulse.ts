import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import { EventEmitter } from 'events';
import { Logger } from 'telegram/extensions/Logger.js';
import * as readline from 'readline';

/**
 * TelegramPulse - Détection de signaux Telegram pour tokens Solana
 * 
 * Features:
 * - Écoute des messages Telegram en temps réel
 * - Détection d'adresses Solana (Base58, 32-44 chars) via regex stricte
 * - Filtrage du bruit (dexscreener, birdeye)
 * - Authentification avec session persistante
 * - Optimisé pour la latence (logger désactivé sauf erreurs)
 * - Gestion robuste des déconnexions (5 tentatives)
 */

/**
 * Événements émis par TelegramPulse
 */
export interface TelegramPulseEvents {
  'newSignal': (signal: {
    mint: string;
    source: 'Telegram';
    score: number;
    timestamp: number;
    /** Texte brut du message (pour NLPPipeline / ViralityScorer) */
    rawText: string;
  }) => void;
  'connected': () => void;
  'disconnected': () => void;
  'error': (error: Error) => void;
}

/**
 * Options de configuration pour TelegramPulse
 */
export interface TelegramPulseOptions {
  apiId?: number;
  apiHash?: string;
  sessionString?: string;
}

export class TelegramPulse extends EventEmitter {
  private client: TelegramClient | null = null;
  private isRunning: boolean = false;
  private apiId: number;
  private apiHash: string;
  private sessionString: string;

  // Regex stricte pour adresses Solana Base58 (32-44 caractères)
  // Base58 alphabet: 1-9, A-H, J-N, P-Z, a-k, m-z (pas de 0, O, I, l)
  private readonly SOLANA_ADDRESS_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

  // Mots-clés à filtrer (bruit)
  private readonly NOISE_KEYWORDS = ['dexscreener', 'birdeye'];

  constructor(options: TelegramPulseOptions = {}) {
    super();

    // Charge depuis options ou variables d'environnement
    this.apiId = options.apiId || parseInt(process.env.TELEGRAM_API_ID || '0');
    this.apiHash = options.apiHash || process.env.TELEGRAM_API_HASH || '';
    this.sessionString = options.sessionString || process.env.TELEGRAM_SESSION_STRING || '';

    if (!this.apiId || !this.apiHash) {
      throw new Error(
        'TELEGRAM_API_ID et TELEGRAM_API_HASH doivent être définis dans .env ou passés en options'
      );
    }

    // Désactive le logger verbeux (niveau "error" seulement pour réduire I/O)
    Logger.setLevel('error');
  }

  /**
   * Démarre TelegramPulse avec authentification
   * 
   * - Si sessionString existe : utilise la session existante
   * - Sinon : login interactif via terminal et affiche la session string
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('[TelegramPulse] ⚠️ Déjà en cours d\'exécution');
      return;
    }

    try {
      console.log('[TelegramPulse] 🚀 Démarrage...');

      // Crée le client Telegram
      const session = new StringSession(this.sessionString);
      this.client = new TelegramClient(session, this.apiId, this.apiHash, {
        connectionRetries: 5, // Gestion robuste des déconnexions
        retryDelay: 1000,
        autoReconnect: true,
      });

      // Démarre le client (authentification)
      await this.client.start({
        phoneNumber: async () => {
          // Si pas de session, demande le numéro de téléphone
          if (!this.sessionString) {
            return await this.promptPhoneNumber();
          }
          return '';
        },
        password: async () => {
          // Si 2FA activé, demande le mot de passe
          return await this.promptPassword();
        },
        phoneCode: async () => {
          // Code reçu par SMS
          return await this.promptPhoneCode();
        },
        onError: (err) => {
          console.error('[TelegramPulse] ❌ Erreur authentification:', err);
          this.emit('error', err as Error);
        },
      });

      // Affiche la session string pour sauvegarde (si nouvelle session)
      if (!this.sessionString && this.client.session instanceof StringSession) {
        const currentSessionString = this.client.session.save();
        if (currentSessionString) {
          console.log('\n' + '═'.repeat(60));
          console.log('💾 SESSION STRING (à copier dans .env):');
          console.log('═'.repeat(60));
          console.log(`TELEGRAM_SESSION_STRING=${currentSessionString}`);
          console.log('═'.repeat(60) + '\n');
        }
      }

      // Configure les handlers d'événements
      this.setupEventHandlers();

      this.isRunning = true;
      this.emit('connected');
      console.log('[TelegramPulse] ✅ Connecté et en écoute');
    } catch (error) {
      console.error('[TelegramPulse] ❌ Erreur lors du démarrage:', error);
      this.emit('error', error as Error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Arrête TelegramPulse proprement
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.client) {
      return;
    }

    console.log('[TelegramPulse] 🛑 Arrêt en cours...');

    try {
      await this.client.disconnect();
      this.client = null;
      this.isRunning = false;
      this.emit('disconnected');
      console.log('[TelegramPulse] ✅ Arrêté');
    } catch (error) {
      console.error('[TelegramPulse] ❌ Erreur lors de l\'arrêt:', error);
      this.emit('error', error as Error);
    }
  }

  /**
   * Configure les handlers d'événements Telegram
   */
  private setupEventHandlers(): void {
    if (!this.client) {
      return;
    }

    // Écoute les nouveaux messages
    this.client.addEventHandler(
      async (event) => {
        await this.handleNewMessage(event);
      },
      new NewMessage({})
    );

    // Gestion des erreurs de connexion (via try-catch dans les handlers)
    // Les erreurs sont déjà gérées dans handleNewMessage et start()
  }

  /**
   * Gère les nouveaux messages Telegram
   * 
   * @param event - Événement NewMessage de Telegram
   */
  private async handleNewMessage(event: any): Promise<void> {
    try {
      const message = event.message;
      if (!message || !message.text) {
        return; // Pas de texte, ignore
      }

      const rawText = message.text.toString();
      const text = rawText.toLowerCase();

      // Filtre le bruit (dexscreener, birdeye)
      if (this.containsNoise(text)) {
        return; // Ignore les messages avec bruit
      }

      // Recherche les adresses Solana avec regex stricte
      const matches = text.match(this.SOLANA_ADDRESS_REGEX);

      if (!matches || matches.length === 0) {
        return; // Aucune adresse trouvée
      }

      // Traite chaque adresse trouvée
      for (const mint of matches) {
        // Validation supplémentaire : vérifie que c'est bien une adresse Solana valide
        // (pas un mot aléatoire qui matche la regex)
        if (this.isValidSolanaAddress(mint)) {
          console.log(`[TelegramPulse] 📣 Signal détecté: ${mint}`);

          // Émet l'événement newSignal
          this.emit('newSignal', {
            mint,
            source: 'Telegram',
            score: 85, // Score fixe selon spécifications
            timestamp: Date.now(),
            rawText,
          });
        }
      }
    } catch (error) {
      console.error('[TelegramPulse] ❌ Erreur handleNewMessage:', error);
      this.emit('error', error as Error);
    }
  }

  /**
   * Vérifie si le message contient du bruit (dexscreener, birdeye)
   * 
   * @param text - Texte du message (en lowercase)
   * @returns true si bruit détecté
   */
  private containsNoise(text: string): boolean {
    return this.NOISE_KEYWORDS.some((keyword) => text.includes(keyword));
  }

  /**
   * Valide qu'une chaîne est bien une adresse Solana valide
   * 
   * Vérifications supplémentaires :
   * - Longueur exacte (32 ou 44 caractères pour les adresses Solana)
   * - Pas de caractères invalides
   * 
   * @param address - Adresse candidate
   * @returns true si valide
   */
  private isValidSolanaAddress(address: string): boolean {
    // Les adresses Solana standards font 32 ou 44 caractères (Base58)
    // On accepte 32-44 pour être flexible avec les formats
    if (address.length < 32 || address.length > 44) {
      return false;
    }

    // Vérifie qu'il n'y a pas de caractères invalides (Base58 strict)
    // Base58 n'inclut pas: 0, O, I, l
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    return base58Regex.test(address);
  }

  /**
   * Prompt interactif pour le numéro de téléphone
   */
  private async promptPhoneNumber(): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question('📱 Entrez votre numéro de téléphone (avec indicatif pays, ex: +33612345678): ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  /**
   * Prompt interactif pour le code de vérification SMS
   */
  private async promptPhoneCode(): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question('🔐 Entrez le code reçu par SMS: ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  /**
   * Prompt interactif pour le mot de passe 2FA
   */
  private async promptPassword(): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question('🔒 Entrez votre mot de passe 2FA: ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  /**
   * Statistiques pour monitoring
   */
  getStats(): {
    isRunning: boolean;
    hasSession: boolean;
  } {
    return {
      isRunning: this.isRunning,
      hasSession: this.sessionString.length > 0,
    };
  }

  /** Client GramJS actif (pour TelegramTokenScanner). Null si non démarré. */
  getClient(): TelegramClient | null {
    return this.client;
  }
}
