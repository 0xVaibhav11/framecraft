// Static counterpart of packages/privacy/src/engine.ts for browser bundling.
// The build resolves these internal imports against the pinned engine revision.
export { deriveNodes, WalletNode } from 'railgun-internal/key-derivation/wallet-node.js';
export { poseidon, initPoseidonPromise } from 'railgun-internal/utils/poseidon.js';
export { signEDDSA, getSharedSymmetricKey } from 'railgun-internal/utils/keys-utils.js';
export { MERKLE_ZERO_VALUE } from 'railgun-internal/models/merkletree-types.js';
export { Transaction } from 'railgun-internal/transaction/transaction.js';
export { encodeAddress, decodeAddress } from 'railgun-internal/key-derivation/bech32.js';
import WalletInfo from 'railgun-internal/wallet/wallet-info.js';
import { getTokenDataERC20 } from '@railgun-community/engine';
(WalletInfo.default ?? WalletInfo).setWalletSource('framepay');
export const erc20TokenData = {
  async getTokenDataFromHash(_version, _chain, hash) {
    if (BigInt(`0x${hash.replace(/^0x/, '')}`) >= 1n << 160n) throw new Error('NFT notes are unsupported');
    return getTokenDataERC20(hash);
  },
};
