import { isAddress, zeroAddress } from 'viem';
import { getProfile } from '@forshtat/hegota-support/profiles';
import { frame } from '@forshtat/hegota-support/tx';
import { requireCondition } from './errors.js';
import type { FrameProfileId, PrepareTransferParameters, TransferPlan } from './types.js';

const uint256 = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n && value < (1n << 256n);
const account = (value: unknown) => typeof value === 'string' && isAddress(value) && value.toLowerCase() !== zeroAddress;
function check(condition: unknown, message: string): asserts condition {
  requireCondition(condition, 'INVALID_TRANSACTION', message, 'prepare');
}

/** Build a local transfer draft without RPC, signing, or claiming paymaster eligibility.
 * The SDK's prepareTransfer action also checks chain, EOA targets, funding and paymaster code.
 */
export function buildTransferPlan(input: PrepareTransferParameters & { profile: FrameProfileId }): TransferPlan {
  const p = structuredClone(input);
  requireCondition(p.profile === 'ethrex-eip8141-tracer', 'UNSUPPORTED_PROFILE', 'Transfer composition supports the ethrex-eip8141-tracer profile only.', 'prepare');
  check(account(p.sender) && account(p.transfer?.to), 'Use nonzero sender and recipient addresses.');
  check(uint256(p.transfer.value), 'Transfer value must be a nonnegative uint256 amount in wei.');
  check(p.rules && Array.isArray(p.rules.allowedRecipients) && p.rules.allowedRecipients.length > 0
    && p.rules.allowedRecipients.every(account), 'Provide a nonempty allowlist of valid recipient addresses.');
  check(p.rules.allowedRecipients.some((address) => address.toLowerCase() === p.transfer.to.toLowerCase()), 'Recipient is outside the draft allowlist.');
  check(uint256(p.rules.maxValue) && p.transfer.value <= p.rules.maxValue, 'Transfer exceeds the draft value limit.');
  check(uint256(p.maxFeePerGas) && p.maxFeePerGas > 0n && uint256(p.rules.maxFeePerGas)
    && p.maxFeePerGas <= p.rules.maxFeePerGas, 'Gas price exceeds the draft limit or is invalid.');
  check(p.payment?.type === 'self' || p.payment?.type === 'paymaster', 'Choose self payment or a paymaster.');
  const profile = getProfile(p.profile);
  const frames = [frame(profile, 'VERIFY', {
    scope: p.payment.type === 'self' ? 'EXECUTION_AND_PAYMENT' : 'EXECUTION', execution: 30_000n,
  })];
  let payer = p.sender;
  if (p.payment.type === 'paymaster') {
    check(account(p.payment.address) && p.payment.address.toLowerCase() !== p.sender.toLowerCase(), 'Choose a nonzero paymaster distinct from the sender.');
    const data = p.payment.verificationData ?? '0x';
    check(typeof data === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(data), 'Paymaster verification data must be whole hex bytes.');
    const gas = p.payment.verificationGas ?? { execution: 50_000n, state: 0n };
    check(uint256(gas.execution) && gas.execution > 0n && uint256(gas.state), 'Invalid paymaster verification gas limits.');
    payer = p.payment.address;
    frames.push(frame(profile, 'VERIFY', { target: payer, scope: 'PAYMENT', data, execution: gas.execution, state: gas.state }));
  }
  frames.push(frame(profile, 'SENDER', { target: p.transfer.to, value: p.transfer.value, execution: 50_000n, state: 200_000n }));
  return {
    parameters: { sender: p.sender, frames, maxFeePerGas: p.maxFeePerGas },
    summary: { sender: p.sender, recipient: p.transfer.to, value: p.transfer.value, payer,
      paymentType: p.payment.type, frameCount: frames.length, maxFeePerGas: p.maxFeePerGas,
      rulesEnforcement: 'local-draft-only', sponsorship: p.payment.type === 'self' ? 'not-requested' : 'unconfirmed' },
  };
}
