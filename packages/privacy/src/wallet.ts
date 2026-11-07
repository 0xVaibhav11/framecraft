import { randomBytes } from 'node:crypto';
import { Mnemonic, TransactNote, ShieldNote, ShieldNoteERC20, getTokenDataERC20, OutputType, TXIDVersion } from '@railgun-community/engine';
import type { Address } from 'viem';
import { CHAIN, bytes, hex32, type PrivateWallet, type OwnedNote, type MerkleView } from './domain.js';
import { deriveNodes, WalletNode, initPoseidonPromise, signEDDSA, poseidon, getSharedSymmetricKey, erc20TokenData } from './engine.js';
import { check } from './errors.js';
import type { PrivateTree } from './tree.js';
export const VERSION = TXIDVersion.V2_PoseidonMerkle;

export async function makeWallet(label: string, tree: MerkleView, mnemonic = Mnemonic.generate()): Promise<PrivateWallet> {
  await initPoseidonPromise;
  const nodes = deriveNodes(mnemonic, 0);
  const spending = nodes.spending.getSpendingKeyPair();
  const viewing = await nodes.viewing.getViewingKeyPair();
  const nullifyingKey = await nodes.viewing.getNullifyingKey();
  const address = { masterPublicKey: WalletNode.getMasterPublicKey(spending.pubkey, nullifyingKey), viewingPublicKey: viewing.pubkey };
  return { label, mnemonic, address, addressKeys: address, viewingKeyPair: viewing, notes: [],
    getUTXOMerkletree: () => tree, getSpendingKeyPair: async () => spending,
    getViewingKeyPair: () => viewing, getNullifyingKey: () => nullifyingKey,
    sign: (inputs) => signEDDSA(spending.privateKey, poseidon([inputs.merkleRoot, inputs.boundParamsHash, ...inputs.nullifiers, ...inputs.commitmentsOut])),
  };
}

export type PrivateViewWallet = Pick<PrivateWallet, 'address' | 'viewingKeyPair' | 'notes' | 'getNullifyingKey'>;

export async function scan(wallet: PrivateViewWallet, tree: PrivateTree): Promise<OwnedNote[]> {
  const owned: OwnedNote[] = [];
  const viewing = wallet.viewingKeyPair;
  for (const event of tree.events) {
    let note: OwnedNote['note'];
    try {
      if (event.kind === 'Shield') {
        const shared = await getSharedSymmetricKey(viewing.privateKey, bytes(event.ciphertext.shieldKey));
        if (!shared) continue;
        const random = ShieldNote.decryptRandom([...event.ciphertext.encryptedBundle], shared);
        const c = event.preimage;
        if (ShieldNote.getNotePublicKey(wallet.address.masterPublicKey, random) !== BigInt(c.npk)) continue;
        note = { random, value: c.value, tokenData: getTokenDataERC20(c.token.tokenAddress), hash: BigInt(event.hash) };
      } else {
        const c = event.ciphertext;
        const shared = await getSharedSymmetricKey(viewing.privateKey, bytes(c.blindedSenderViewingKey));
        if (!shared) continue;
        const first = c.ciphertext[0].slice(2);
        note = await TransactNote.decrypt(VERSION, CHAIN, wallet.address,
          { iv: first.slice(0, 32), tag: first.slice(32), data: c.ciphertext.slice(1).map((h) => h.slice(2)) },
          shared, c.memo.slice(2), c.annotationData.slice(2), viewing.privateKey,
          bytes(c.blindedReceiverViewingKey), bytes(c.blindedSenderViewingKey), false, false,
          erc20TokenData, event.blockNumber, undefined);
        check(note.hash === BigInt(event.hash), 'Decrypted note commitment mismatch');
      }
    } catch { continue; } // Authenticated decryption fails for notes owned by other wallets.
    const nullifier = hex32(TransactNote.getNullifier(wallet.getNullifyingKey(), event.position));
    // RPC errors must propagate; silently treating a spent note as spendable is unsafe.
    if (!await tree.isSpent(nullifier)) owned.push({ position: event.position, note, nullifier });
  }
  wallet.notes = owned;
  return owned;
}
export const balance = (wallet: Pick<PrivateWallet, 'notes'>, token: Address): bigint => wallet.notes
  .filter((n) => n.note.tokenData.tokenAddress.toLowerCase() === token.toLowerCase())
  .reduce((sum, n) => sum + n.note.value, 0n);
export function select(wallet: PrivateWallet, token: Address, amount: bigint): OwnedNote {
  check(amount > 0n && amount < 1n << 120n, 'Payment amount must be a positive uint120');
  const found = wallet.notes.find((n) => n.note.tokenData.tokenAddress.toLowerCase() === token.toLowerCase() && n.note.value >= amount);
  check(found !== undefined, 'No single unspent note covers the requested payment');
  return found!;
}
export function outputs(sender: PrivateWallet, receiver: PrivateWallet, input: OwnedNote, amount: bigint): [TransactNote, TransactNote] {
  check(amount > 0n && amount <= input.note.value, 'Payment must fit the input note');
  return [TransactNote.createTransfer(receiver.address, sender.address, amount, input.note.tokenData, false, OutputType.Transfer, undefined),
    TransactNote.createTransfer(sender.address, sender.address, input.note.value - amount, input.note.tokenData, false, OutputType.Change, undefined)];
}
export async function shieldRequest(wallet: PrivateWallet, token: Address, amount: bigint) {
  check(amount > 0n && amount < 1n << 120n, 'Shield amount must be a positive uint120');
  const note = new ShieldNoteERC20(wallet.address.masterPublicKey, TransactNote.getNoteRandom(), amount, token);
  return note.serialize(randomBytes(32), wallet.viewingKeyPair.pubkey);
}
