import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export function loadKeypair(privateKeyBase58) {
  if (!privateKeyBase58) {
    throw new Error('PRIVATE_KEY is not set in .env (required when SIMULATION_MODE=false)');
  }
  const secret = bs58.decode(privateKeyBase58.trim());
  return Keypair.fromSecretKey(secret);
}
