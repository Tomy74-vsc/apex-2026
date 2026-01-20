import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getMint, getAccount, TOKEN_PROGRAM_ID, TokenAccountNotFoundError, TokenInvalidAccountOwnerError } from '@solana/spl-token';
import { createJupiterApiClient, type QuoteResponse, type SwapResponse } from '@jup-ag/api';
import type { SecurityReport } from '../types/index.js';

// SOL mint address
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Raydium AMM v4 Program ID
const RAYDIUM_AMM_V4_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

// Adresses de burn communes
const BURN_ADDRESSES = [
  '11111111111111111111111111111111', // System Program (burn)
  '1nc1nerator11111111111111111111111111111111', // Incinerator
];

/**
 * Guard - Analyseur de sécurité on-chain pour tokens Solana
 * 
 * Vérifie les autorités (Mint/Freeze), détecte les honeypots via simulation,
 * calcule un riskScore basé sur la concentration des holders et la liquidité.
 */
export class Guard {
  private connection: Connection;
  private jupiterApi: ReturnType<typeof createJupiterApiClient>;

  constructor(rpcUrl?: string) {
    const heliusRpc = rpcUrl || process.env.HELIUS_RPC_URL || process.env.RPC_URL;
    
    if (!heliusRpc) {
      throw new Error('HELIUS_RPC_URL ou RPC_URL doit être défini dans .env');
    }

    this.connection = new Connection(heliusRpc, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 30000,
    });

    // Initialise l'API Jupiter
    this.jupiterApi = createJupiterApiClient();
  }

  /**
   * Valide un token en vérifiant les autorités mint/freeze via Account Info
   * 
   * @param mint - Adresse du mint token
   * @returns SecurityReport avec validation des autorités
   */
  async validateToken(mint: string): Promise<SecurityReport> {
    return this.analyzeToken(mint);
  }

  /**
   * Analyse complète d'un token pour générer un SecurityReport
   * 
   * @param mint - Adresse publique du mint token
   * @returns SecurityReport avec riskScore et flags de sécurité
   */
  async analyzeToken(mint: string): Promise<SecurityReport> {
    const mintPubkey = new PublicKey(mint);
    const flags: string[] = [];
    let riskScore = 0;

    // 1. Vérification des autorités (MintAuthority & FreezeAuthority)
    const mintInfo = await getMint(this.connection, mintPubkey);
    const mintRenounced = mintInfo.mintAuthority === null;
    const freezeDisabled = mintInfo.freezeAuthority === null;

    if (!mintRenounced) {
      flags.push('MINT_AUTHORITY_NOT_RENOUNCED');
    }

    if (!freezeDisabled) {
      flags.push('FREEZE_AUTHORITY_NOT_DISABLED');
      riskScore += 50; // +50 si freeze n'est pas révoqué
    }

    // 2. Analyse de la distribution des holders (Top 10)
    const top10HoldersPercent = await this.calculateTop10HoldersPercent(mintPubkey);
    
    if (top10HoldersPercent > 50) {
      flags.push('HIGH_CONCENTRATION');
      riskScore += 30; // +30 si top 10 holders > 50%
    }

    // 3. Détection de honeypot via simulation de swap
    const isHoneypot = await this.detectHoneypot(mintPubkey);
    if (isHoneypot) {
      flags.push('HONEYPOT_DETECTED');
      riskScore += 100; // Honeypot = risque maximum
    }

    // 4. Vérification de la liquidité Raydium
    const liquidityInfo = await this.checkRaydiumLiquidity(mintPubkey);
    
    if (!liquidityInfo.hasLiquidity) {
      flags.push('NO_LIQUIDITY_POOL');
      riskScore += 40; // +40 si pas de pool de liquidité
    } else if (liquidityInfo.liquiditySol && liquidityInfo.liquiditySol < 5) {
      flags.push('LOW_LIQUIDITY');
      riskScore += 20; // +20 si liquidité < 5 SOL
    }

    // 5. Calcul du LP burned (approximation via getProgramAccounts)
    const lpBurnedPercent = await this.calculateLPBurnedPercent(mintPubkey);

    const isSafe = riskScore < 50 && !isHoneypot && mintRenounced && freezeDisabled && liquidityInfo.hasLiquidity;

    return {
      mint,
      isSafe,
      riskScore: Math.min(riskScore, 100), // Cap à 100
      flags,
      details: {
        mintRenounced,
        freezeDisabled,
        lpBurnedPercent,
        top10HoldersPercent,
        isHoneypot,
        liquiditySol: liquidityInfo.liquiditySol,
        hasLiquidity: liquidityInfo.hasLiquidity,
      },
    };
  }

  /**
   * Calcule le pourcentage détenu par les top 10 holders
   * 
   * @param mintPubkey - PublicKey du mint
   * @returns Pourcentage (0-100) détenu par les top 10 holders
   */
  private async calculateTop10HoldersPercent(mintPubkey: PublicKey): Promise<number> {
    try {
      // Récupère tous les token accounts pour ce mint
      // Offset 0 = mint address dans un token account
      const mintBytes = mintPubkey.toBytes();
      const tokenAccounts = await this.connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
        filters: [
          {
            dataSize: 165, // Taille d'un token account
          },
          {
            memcmp: {
              offset: 0, // Mint address offset dans token account
              bytes: mintBytes,
            },
          },
        ],
      });

      if (tokenAccounts.length === 0) {
        return 0;
      }

      // Parse les balances depuis les accounts
      const holders: { address: string; balance: bigint }[] = [];

      for (const account of tokenAccounts) {
        try {
          const tokenAccount = await getAccount(this.connection, account.pubkey);
          if (tokenAccount.amount > 0n) {
            holders.push({
              address: account.pubkey.toBase58(),
              balance: tokenAccount.amount,
            });
          }
        } catch (err) {
          // Ignore les erreurs de parsing (accounts invalides)
          if (!(err instanceof TokenAccountNotFoundError || err instanceof TokenInvalidAccountOwnerError)) {
            throw err;
          }
        }
      }

      // Trie par balance décroissante
      holders.sort((a, b) => {
        if (b.balance > a.balance) return 1;
        if (b.balance < a.balance) return -1;
        return 0;
      });

      // Calcule le total supply
      const mintInfo = await getMint(this.connection, mintPubkey);
      const totalSupply = mintInfo.supply;

      if (totalSupply === 0n) {
        return 0;
      }

      // Somme des top 10 holders
      const top10Balance = holders
        .slice(0, 10)
        .reduce((sum, holder) => sum + holder.balance, 0n);

      return Number((top10Balance * 100n) / totalSupply);
    } catch (error) {
      console.error('Erreur lors du calcul des top holders:', error);
      return 0; // En cas d'erreur, on assume 0% (safe par défaut)
    }
  }

  /**
   * Détecte les honeypots en simulant une transaction de swap via Jupiter
   * 
   * Un honeypot est détecté si :
   * - Aucune route de swap n'est disponible
   * - La simulation de transaction échoue
   * - Le swap retourne 0 tokens (impossible de vendre)
   * 
   * @param mintPubkey - PublicKey du mint
   * @returns true si honeypot détecté (swap échoue en simulation)
   */
  private async detectHoneypot(mintPubkey: PublicKey): Promise<boolean> {
    try {
      const inputMint = SOL_MINT; // On achète avec SOL
      const outputMint = mintPubkey.toBase58();
      const amount = 1000000; // 0.001 SOL (1M lamports)

      // 1. Vérifie si une route de swap existe
      let quote: QuoteResponse;
      try {
        quote = await this.jupiterApi.quoteGet({
          inputMint,
          outputMint,
          amount,
          slippageBps: 50, // 0.5% slippage
        });
      } catch (error) {
        // Pas de route disponible = probable honeypot
        return true;
      }

      // 2. Si la quote retourne 0 output, c'est un honeypot
      if (!quote.outAmount || quote.outAmount === '0') {
        return true;
      }

      // 3. Essaie de créer une transaction de swap
      // Note: Pour une vraie simulation, il faudrait un wallet signer
      // On simule juste la création de la transaction
      try {
        // Utilise une clé publique valide pour la simulation (peut être n'importe quelle clé)
        const dummyPublicKey = new PublicKey('11111111111111111111111111111111');
        const swapResponse: SwapResponse = await this.jupiterApi.swapPost({
          swapRequest: {
            quoteResponse: quote,
            userPublicKey: dummyPublicKey.toBase58(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 'auto',
          },
        });

        if (!swapResponse.swapTransaction) {
          return true; // Pas de transaction possible = honeypot
        }

        // 4. Simule la transaction
        const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

        const simulation = await this.connection.simulateTransaction(transaction, {
          replaceRecentBlockhash: true,
          sigVerify: false,
        });

        // Si la simulation échoue, c'est probablement un honeypot
        if (simulation.value.err) {
          return true;
        }

        // Si le log contient des erreurs de transfert, c'est un honeypot
        const logs = simulation.value.logs || [];
        const hasTransferError = logs.some(
          (log) =>
            log.includes('insufficient funds') ||
            log.includes('transfer failed') ||
            log.includes('invalid account') ||
            log.includes('unauthorized')
        );

        return hasTransferError;
      } catch (error) {
        // Erreur lors de la création/simulation = probable honeypot
        return true;
      }
    } catch (error) {
      // Si la simulation échoue complètement, on considère que c'est un honeypot
      console.warn('Erreur lors de la simulation de swap:', error);
      return true;
    }
  }

  /**
   * Vérifie la liquidité sur Raydium AMM v4
   * 
   * Récupère le solde du vault SOL du pool pour évaluer la liquidité disponible.
   * 
   * @param mintPubkey - PublicKey du mint token
   * @returns Informations sur la liquidité (SOL amount et existence du pool)
   */
  private async checkRaydiumLiquidity(mintPubkey: PublicKey): Promise<{
    hasLiquidity: boolean;
    liquiditySol?: number;
  }> {
    try {
      // Recherche des pools Raydium AMM v4 contenant ce token
      const pools = await this.connection.getProgramAccounts(RAYDIUM_AMM_V4_PROGRAM_ID, {
        filters: [
          {
            dataSize: 752, // Taille d'un Raydium AMM v4 pool state
          },
        ],
      });

      // Parcourt les pools pour trouver celui qui correspond au token
      for (const pool of pools) {
        try {
          // Parse les données du pool (structure Raydium AMM v4)
          const data = pool.account.data;
          
          // Offset 400: baseMint (32 bytes)
          // Offset 432: quoteMint (32 bytes)
          const baseMint = new PublicKey(data.slice(400, 432));
          const quoteMint = new PublicKey(data.slice(432, 464));

          // Vérifie si c'est le bon pool (token/SOL ou SOL/token)
          const solMintPubkey = new PublicKey(SOL_MINT);
          const isMatchingPool = 
            (baseMint.equals(mintPubkey) && quoteMint.equals(solMintPubkey)) ||
            (baseMint.equals(solMintPubkey) && quoteMint.equals(mintPubkey));

          if (isMatchingPool) {
            // Offset 464: baseVault (32 bytes)
            // Offset 496: quoteVault (32 bytes)
            const baseVault = new PublicKey(data.slice(464, 496));
            const quoteVault = new PublicKey(data.slice(496, 528));

            // Détermine quel vault contient le SOL
            const solVault = baseMint.equals(solMintPubkey) ? baseVault : quoteVault;

            // Récupère le solde du vault SOL
            const vaultBalance = await this.connection.getBalance(solVault);
            const liquiditySol = vaultBalance / 1e9; // Convertit lamports en SOL

            return {
              hasLiquidity: true,
              liquiditySol,
            };
          }
        } catch (err) {
          // Ignore les erreurs de parsing pour ce pool spécifique
          continue;
        }
      }

      // Aucun pool trouvé
      return { hasLiquidity: false };
    } catch (error) {
      console.error('Erreur lors de la vérification de liquidité Raydium:', error);
      return { hasLiquidity: false };
    }
  }

  /**
   * Calcule le pourcentage de LP brûlé
   * 
   * Vérifie si les LP tokens sont dans une adresse de burn.
   * 
   * @param mintPubkey - PublicKey du mint
   * @returns Pourcentage de LP brûlé (approximation)
   */
  private async calculateLPBurnedPercent(mintPubkey: PublicKey): Promise<number> {
    try {
      // Recherche des pools Raydium pour ce token
      const pools = await this.connection.getProgramAccounts(RAYDIUM_AMM_V4_PROGRAM_ID, {
        filters: [
          {
            dataSize: 752,
          },
        ],
      });

      for (const pool of pools) {
        try {
          const data = pool.account.data;
          const baseMint = new PublicKey(data.slice(400, 432));
          const quoteMint = new PublicKey(data.slice(432, 464));

          const solMintPubkey = new PublicKey(SOL_MINT);
          const isMatchingPool = 
            (baseMint.equals(mintPubkey) && quoteMint.equals(solMintPubkey)) ||
            (baseMint.equals(solMintPubkey) && quoteMint.equals(mintPubkey));

          if (isMatchingPool) {
            // Offset 528: lpMint (32 bytes)
            const lpMint = new PublicKey(data.slice(528, 560));

            // Récupère le total supply du LP token
            const lpMintInfo = await getMint(this.connection, lpMint);
            const totalSupply = lpMintInfo.supply;

            if (totalSupply === 0n) {
              return 100; // Tout est brûlé
            }

            // Vérifie combien de LP tokens sont dans les adresses de burn
            let burnedAmount = 0n;

            for (const burnAddress of BURN_ADDRESSES) {
              try {
                const burnPubkey = new PublicKey(burnAddress);
                const tokenAccounts = await this.connection.getTokenAccountsByOwner(burnPubkey, {
                  mint: lpMint,
                });

                for (const account of tokenAccounts.value) {
                  const tokenAccount = await getAccount(this.connection, account.pubkey);
                  burnedAmount += tokenAccount.amount;
                }
              } catch {
                // Ignore si l'adresse n'a pas de token account
                continue;
              }
            }

            return Number((burnedAmount * 100n) / totalSupply);
          }
        } catch {
          continue;
        }
      }

      return 0; // Pool non trouvé
    } catch (error) {
      console.error('Erreur lors du calcul du LP burned:', error);
      return 0;
    }
  }
}