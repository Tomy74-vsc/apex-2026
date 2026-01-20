import { Keypair } from "@solana/web3.js";

const key = Keypair.generate();
console.log("Copie ce tableau complet dans ton .env pour JITO_AUTH_PRIVATE_KEY :");
console.log(`[${key.secretKey.toString()}]`);