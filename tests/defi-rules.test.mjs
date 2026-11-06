import test from 'node:test';
import assert from 'node:assert/strict';
import { amount, assertTransfer, assertSwap, defaultRules, loadRules } from '../apps/web/src/lib/defi-rules.mjs';
import { validateRpcRequest } from '../apps/web/src/lib/rpc-policy.mjs';
const sender = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';

test('amount parser rejects silent rounding, scientific notation and nonpositive inputs', () => {
  assert.equal(amount('1.000001', 6), 1_000_001n);
  for (const value of ['1.0000001', '1e6', '-1', '0', 'NaN', 'Infinity']) assert.throws(() => amount(value, 6));
});
test('saved transfer assertions reject forbidden recipients, excess spend and self-paid gas', () => {
  const rules = { ...defaultRules, allowedRecipients: recipient, maxTokenTransfer: '5' };
  const tx = { sender, recipient, value: 5_000_000n, native: false, sponsored: true };
  assert.equal(assertTransfer(rules, tx), 5_000_000n);
  assert.throws(() => assertTransfer(rules, { ...tx, value: 5_000_001n }));
  assert.throws(() => assertTransfer(rules, { ...tx, recipient: sender }));
  assert.throws(() => assertTransfer(rules, { ...tx, recipient: '0x3333333333333333333333333333333333333333' }));
  assert.throws(() => assertTransfer(rules, { ...tx, sponsored: false }));
});
test('swap assertions enforce both sides of the quote and sponsorship preference', () => {
  const rules = { ...defaultRules, maxSwapInput: '1', minimumSwapOutput: '10' };
  const quote = { input: 10n ** 18n, output: 10_000_000n, sponsored: true };
  assert.doesNotThrow(() => assertSwap(rules, quote));
  assert.throws(() => assertSwap(rules, { ...quote, input: quote.input + 1n }));
  assert.throws(() => assertSwap(rules, { ...quote, output: quote.output - 1n }));
  assert.throws(() => assertSwap(rules, { ...quote, sponsored: false }));
});
test('corrupt or invalid saved rules return validated defaults', () => {
  assert.deepEqual(loadRules('not json'), defaultRules);
  assert.deepEqual(loadRules(JSON.stringify({ ...defaultRules, deadlineMinutes: '1000' })), defaultRules);
  assert.equal(loadRules(JSON.stringify({ ...defaultRules, maxTokenTransfer: '20' })).maxTokenTransfer, '20');
});
test('contract reads permit bounded calldata and reject state overrides or value-bearing calls', () => {
  const payload = params => ({ jsonrpc: '2.0', id: 1, method: 'eth_call', params });
  const call = { to: recipient, data: '0x70a08231' };
  assert.equal(validateRpcRequest(payload([call, 'latest'])), true);
  for (const params of [[call, 'pending'], [call, 'latest', {}], [{ ...call, value: '0x1' }, 'latest'], [{ ...call, data: '0x123' }, 'latest'], [{ ...call, data: '0x' + '00'.repeat(32769) }, 'latest']])
    assert.equal(validateRpcRequest(payload(params)), false);
});
