import type { PrivateWallet } from './domain.js';
import type { PrivateViewWallet } from './wallet.js';

/** Copy only the material needed to decrypt notes and check spent nullifiers. */
export function makeViewWallet(source: PrivateWallet): {wallet: PrivateViewWallet; dispose(): void} {
  let nullifyingKey = source.getNullifyingKey();
  const wallet: PrivateViewWallet = {
    address: {...source.address, viewingPublicKey: source.address.viewingPublicKey.slice()},
    viewingKeyPair: {privateKey: source.viewingKeyPair.privateKey.slice(), pubkey: source.viewingKeyPair.pubkey.slice()},
    notes: [], getNullifyingKey: () => nullifyingKey,
  };
  return {wallet, dispose() {wallet.viewingKeyPair.privateKey.fill(0);nullifyingKey=0n;wallet.notes=[];}};
}
