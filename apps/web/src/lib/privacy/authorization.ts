import { quantumChallenge } from '@framepay/sdk';
import type { Address, Hex } from 'viem';
import type { BrowserPrivateResult } from '../../../../../scripts/private/browser/types';

/** Recheck the worker's exact consent before any relay transaction is built. */
export function privateAuthorizationArgs(wallet: { address: Address; networkDomain: Hex }, result: BrowserPrivateResult) {
  const auth = result.authorization;
  if (!auth || !result.deadline || auth.owner.toLowerCase() !== wallet.address.toLowerCase() || auth.networkDomain !== wallet.networkDomain)
    throw new Error('Private authorization belongs to another wallet or chain.');
  const calls = result.calls.map(call => ({ target: call.to, value: 0n, data: call.data }));
  if (!calls.length || quantumChallenge({ chainId: 1337n, wallet: wallet.address, networkDomain: wallet.networkDomain, nonce: auth.nonce, deadline: BigInt(result.deadline), calls }) !== auth.challenge)
    throw new Error('Private batch changed after approval.');
  return [calls, auth.nonce, BigInt(result.deadline), auth.proof] as const;
}
