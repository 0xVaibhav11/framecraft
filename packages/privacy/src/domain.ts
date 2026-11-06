import type { AddressData, SpendingKeyPair, ViewingKeyPair, TransactNote, PublicInputsRailgun, TransactionStructV2 } from '@railgun-community/engine';
import type { Address, Hex } from 'viem';

export type { TransactionStructV2 as PrivateTransaction } from '@railgun-community/engine';
export const CHAIN = { type: 0, id: 1337 } as const;
export const ZERO = '0x0000000000000000000000000000000000000000' as const;
export const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
export const hex32 = (value: bigint | string | number): Hex => {
  const n = BigInt(value);
  if (n < 0n || n >= 1n << 256n) throw new RangeError('Expected uint256');
  return `0x${n.toString(16).padStart(64, '0')}`;
};
export const bytes = (hex: string): Uint8Array => Buffer.from(hex.replace(/^0x/, ''), 'hex');
export interface OwnedNote {
  readonly position: number;
  readonly nullifier: Hex;
  readonly note: Pick<TransactNote, 'random' | 'value' | 'tokenData' | 'hash'>;
}
export interface MerkleView {
  getRoot(): string;
  getMerkleProof(tree: number, position: number): { elements: string[] };
}
/** Local test wallet facade. No persistent secret store is provided by the library. */
export interface PrivateWallet {
  readonly label: string;
  readonly mnemonic: string;
  readonly address: AddressData;
  readonly addressKeys: AddressData;
  readonly viewingKeyPair: ViewingKeyPair;
  notes: OwnedNote[];
  getUTXOMerkletree(): MerkleView;
  getSpendingKeyPair(): Promise<SpendingKeyPair>;
  getViewingKeyPair(): ViewingKeyPair;
  getNullifyingKey(): bigint;
  sign(inputs: PublicInputsRailgun): { R8: [bigint, bigint]; S: bigint };
}
export interface ProofOptions {
  readonly adapter?: Address;
  readonly params?: Hex;
  readonly unshield?: { readonly to: Address; readonly amount: bigint };
}
export interface ProvedPayment { readonly transaction: TransactionStructV2; readonly proofMs: number }
export interface Quote {
  readonly tradeId: Hex;
  readonly deadline: bigint;
  readonly payment0: Hex;
  readonly payment1: Hex;
}
export interface CircuitArtifacts { wasm: Uint8Array; zkey: Uint8Array; vkey: object }
