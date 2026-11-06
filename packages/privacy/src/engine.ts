/** The pinned engine does not export these helpers. All internal API coupling lives here. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { getTokenDataERC20, type TokenDataGetter } from '@railgun-community/engine';
import type { SpendingKeyPair, ViewingKeyPair, Prover, TokenData, TransactNote,
  RailgunTransactionRequest, UnprovedTransactionInputs, TransactionStructV2, TXIDVersion } from '@railgun-community/engine';
import type { PrivateWallet, OwnedNote } from './domain.js';
const require = createRequire(import.meta.url);
const directory = path.dirname(require.resolve('@railgun-community/engine'));
const load = <T>(file: string): T => require(path.join(directory, file)) as T;
interface WalletNode {
  getSpendingKeyPair(): SpendingKeyPair;
  getViewingKeyPair(): Promise<ViewingKeyPair>;
  getNullifyingKey(): Promise<bigint>;
}
export const { deriveNodes, WalletNode } = load<{
  deriveNodes(mnemonic: string, index: number): { spending: WalletNode; viewing: WalletNode };
  WalletNode: { getMasterPublicKey(key: [bigint, bigint], nullifyingKey: bigint): bigint };
}>('key-derivation/wallet-node.js');
export const { poseidon, initPoseidonPromise } = load<{
  poseidon(inputs: bigint[]): bigint; initPoseidonPromise: Promise<void>;
}>('utils/poseidon.js');
export const { signEDDSA, getSharedSymmetricKey } = load<{
  signEDDSA(key: Uint8Array, message: bigint): { R8: [bigint, bigint]; S: bigint };
  getSharedSymmetricKey(key: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array | undefined>;
}>('utils/keys-utils.js');
export const { MERKLE_ZERO_VALUE } = load<{ MERKLE_ZERO_VALUE: string }>('models/merkletree-types.js');
load<{ default: { setWalletSource(source: string): void } }>('wallet/wallet-info.js').default.setWalletSource('framepay');
interface EngineTransaction {
  addUnshieldData(data: { tokenData: TokenData; toAddress: string; allowOverride: boolean }, amount: bigint): void;
  generateTransactionRequest(wallet: PrivateWallet, version: TXIDVersion, encryptionKey: string,
    params: { minGasPrice: bigint; chainID: bigint; senderCiphertext: string; to: string; data: string }): Promise<RailgunTransactionRequest>;
  generateProvedTransaction(version: TXIDVersion, prover: Prover, inputs: UnprovedTransactionInputs,
    progress: () => void): Promise<TransactionStructV2>;
}
export const { Transaction } = load<{ Transaction: new (
  chain: { type: number; id: number }, token: TokenData, tree: number, inputs: OwnedNote[], outputs: TransactNote[],
  adapt: { contract: string; parameters: string }
) => EngineTransaction }>('transaction/transaction.js');

// TransactNote only calls this public method. Reject NFTs instead of supplying a fake database.
export const erc20TokenData = {
  async getTokenDataFromHash(_version: TXIDVersion, _chain: { type: number; id: number }, hash: string) {
    const value = BigInt(`0x${hash.replace(/^0x/, '')}`);
    if (value >= 1n << 160n) throw new Error('NFT notes are unsupported');
    return getTokenDataERC20(hash);
  },
} as TokenDataGetter;
