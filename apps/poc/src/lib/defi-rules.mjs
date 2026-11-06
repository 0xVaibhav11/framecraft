import { isAddress, parseUnits, zeroAddress } from 'viem';

export const defaultRules = {
  maxTokenTransfer: '100', maxNativeTransfer: '0.01', maxSwapInput: '10',
  minimumSwapOutput: '0.01', deadlineMinutes: '10', allowedRecipients: '', requireSponsor: true,
};
/** Strict decimal input: reject precision loss before viem can round a user's amount. */
export function amount(value, decimals, label = 'Amount') {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())
    || (value.split('.')[1]?.length ?? 0) > decimals) throw new Error(`${label} needs a positive number with up to ${decimals} decimal places.`);
  const result = parseUnits(value.trim(), decimals);
  if (result <= 0n || result > (1n << 128n) - 1n) throw new Error(`${label} is outside the supported range.`);
  return result;
}
/** @param {typeof defaultRules} rules */
export function validateRules(rules) {
  amount(rules.maxTokenTransfer, 6, 'Token transfer limit');
  amount(rules.maxNativeTransfer, 18, 'ETH transfer limit');
  amount(rules.maxSwapInput, 18, 'Swap input limit');
  amount(rules.minimumSwapOutput, 6, 'Minimum swap output');
  if (!/^\d+$/.test(rules.deadlineMinutes) || Number(rules.deadlineMinutes) < 1 || Number(rules.deadlineMinutes) > 60)
    throw new Error('Transaction expiry must be between 1 and 60 minutes.');
  if (typeof rules.requireSponsor !== 'boolean') throw new Error('Choose whether sponsorship is required.');
  const recipients = rules.allowedRecipients.split(/[\s,]+/).filter(Boolean);
  if (recipients.some(value => !isAddress(value) || value.toLowerCase() === zeroAddress))
    throw new Error('Recipient rules must contain valid, nonzero Ethereum addresses.');
  return recipients.map(value => value.toLowerCase());
}
/** @param {typeof defaultRules} rules */
export function assertTransfer(rules, { recipient, sender, value, native, sponsored }) {
  const allowed = validateRules(rules);
  if (!isAddress(recipient) || recipient.toLowerCase() === zeroAddress || recipient.toLowerCase() === sender.toLowerCase())
    throw new Error('Choose a valid recipient different from your account.');
  if (allowed.length && !allowed.includes(recipient.toLowerCase())) throw new Error('This recipient is not in your allowed list.');
  const limit = amount(native ? rules.maxNativeTransfer : rules.maxTokenTransfer, native ? 18 : 6, 'Transfer limit');
  if (value <= 0n || value > limit) throw new Error('Transfer exceeds your saved amount limit.');
  if (rules.requireSponsor && !sponsored) throw new Error('Your rules require the paymaster to sponsor gas.');
  return limit;
}
/** @param {typeof defaultRules} rules */
export function assertSwap(rules, { input, output, sponsored }) {
  validateRules(rules);
  if (input <= 0n || input > amount(rules.maxSwapInput, 18, 'Swap input limit')) throw new Error('Swap exceeds your saved input limit.');
  if (output < amount(rules.minimumSwapOutput, 6, 'Minimum swap output')) throw new Error('Swap output is below your saved minimum.');
  if (rules.requireSponsor && !sponsored) throw new Error('Your rules require the paymaster to sponsor gas.');
}
/** @param {string | null} raw */
export function loadRules(raw) {
  try {
    const value = JSON.parse(raw);
    const result = Object.fromEntries(Object.keys(defaultRules).map(key => [key, value[key] ?? defaultRules[key]]));
    validateRules(result);
    return result;
  } catch { return { ...defaultRules }; }
}
