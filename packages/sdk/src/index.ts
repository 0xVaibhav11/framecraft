import { createClient, type Chain, type Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signTx } from '@forshtat/hegota-support/tx';
import type { Hex } from 'viem';
import type { FrameProfileId, FrameSigner } from './types.js';
import { frameActions } from './actions.js';
import { FramePayError, requireCondition } from './errors.js';

export { frameActions } from './actions.js';
export { FramePayError } from './errors.js';
export type * from './types.js';
export type { FramePayErrorCode, FramePayPhase } from './errors.js';
export { frame, secp256k1Placeholder, sigHash, txHash } from '@forshtat/hegota-support/tx';
export { getProfile } from '@forshtat/hegota-support/profiles';

export function createFrameClient({ chain, transport, profile }: { chain: Chain; transport: Transport; profile: FrameProfileId }) {
  return createClient({ chain, transport, name: 'FramePay', key: 'framepay' }).extend(frameActions({ profile }));
}

/** Local SECP256K1 adapter for the workshop baseline. This is not PQ authorization or a browser-wallet adapter. */
export function privateKeyToFrameSigner(privateKey: Hex): FrameSigner {
  let account;
  try { account = privateKeyToAccount(privateKey); }
  catch { throw new FramePayError('SIGNING_FAILED', 'Cannot initialize the local signer from the supplied key.', { phase: 'sign' }); }
  return {
    address: account.address,
    async sign({ profile, transaction }) {
      requireCondition(transaction.signatures.length === 1
        && transaction.signatures[0].scheme === profile.sigSchemes.SECP256K1
        && transaction.signatures[0].msg === '0x',
      'INVALID_TRANSACTION', 'This signer supports one canonical-hash SECP256K1 authorization entry.', 'sign');
      const declared = transaction.signatures[0].signer;
      requireCondition(declared === '0x' ? transaction.sender.toLowerCase() === account.address.toLowerCase()
        : declared.toLowerCase() === account.address.toLowerCase(),
      'INVALID_TRANSACTION', 'Signer does not match the declared owner or self-authorizing sender.', 'sign');
      return signTx(profile, transaction, privateKey);
    },
  };
}
