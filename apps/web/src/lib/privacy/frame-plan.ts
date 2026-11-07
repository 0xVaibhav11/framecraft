import { encodeFunctionData, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { quantumWalletAbi } from '@framepay/sdk';
import type { FrameAction, FrameSpec } from '@evmcrispr/sdk';
import type { BrowserPrivateRequest, BrowserPrivateResult } from '../../../../../scripts/private/browser/types';
import { frameBudgets } from '../../../../poc/src/lib/frame-budgets';
import { decodePrivateFrame, isPrivateFrameData } from './frame-intent.mjs';
import { validatePrivateIntent } from './requests';
import { privateAuthorizationArgs } from './authorization';

export const hasPrivateFrames = (action: FrameAction) => action.frames.some(f => isPrivateFrameData(f.data));
export const privateFrameContext = (action: FrameAction): Hex => keccak256(stringToHex(JSON.stringify(action, (_, v) => typeof v === 'bigint' ? v.toString() : v)));
export function privateFrameRequests(action: FrameAction): BrowserPrivateRequest[] {
  return action.frames.filter(f => isPrivateFrameData(f.data)).map(spec => {
    if (spec.mode !== 'sender' || spec.target !== null || spec.value !== 0n || spec.approve)
      throw new Error('Private operations must be SENDER body frames with zero native value.');
    const request = validatePrivateIntent(decodePrivateFrame(spec.data));
    if (request.action === 'quote' || request.action === 'lock' || request.action === 'scan')
      throw new Error('Only private spending operations can be included in frame:tx.');
    return request;
  });
}
/** Preserve order, explicit gas limits and atomic boundaries; replace only private compiler descriptors. */
export function materializePrivateFrames(action: FrameAction, wallet: { address: Address; networkDomain: Hex }, result: BrowserPrivateResult): FrameSpec[] {
  const requests = privateFrameRequests(action);
  if (!requests.length || result.frameContext !== privateFrameContext(action) || result.batches?.length !== requests.length)
    throw new Error('Private proofs do not match the approved frame plan.');
  const baseNonce = result.batches[0].authorization?.nonce;
  if (baseNonce === undefined) throw new Error('Missing private frame authorization.');
  let i = 0;
  return action.frames.map(spec => {
    if (!isPrivateFrameData(spec.data)) return { ...spec };
    const batch = result.batches![i];
    if (batch.authorization?.nonce !== baseNonce + BigInt(i++) || batch.deadline !== result.batches![0].deadline)
      throw new Error('Private frame authorizations have inconsistent nonces or deadlines.');
    const args = privateAuthorizationArgs(wallet, batch);
    return { ...spec, target: wallet.address,
      data: encodeFunctionData({ abi: quantumWalletAbi, functionName: 'execute', args }),
      gas: spec.gas ?? frameBudgets.quantum.execution, stateGas: spec.stateGas ?? frameBudgets.quantum.state };
  });
}
