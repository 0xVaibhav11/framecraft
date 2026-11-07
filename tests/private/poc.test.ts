import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePrivateAction } from '../../scripts/private/poc-types.ts';

test('private controls require bounded amounts, exact swap outputs and withdrawal recipients', () => {
  for (const action of ['shield', 'transfer', 'add-inventory', 'remove-inventory']) {
    assert.doesNotThrow(() => validatePrivateAction({ action, expectedRevision: 'reviewed', amount: '1.5', wallet: 'maker', receiver: 'taker', token: 'A' }));
  }
  assert.doesNotThrow(() => validatePrivateAction({ action: 'swap', expectedRevision: 'reviewed', amount: '500', expectedOutput: '200' }));
  for (const amount of ['0', '-1', '1e3', '10001', '0.0000000000000000001', 'NaN'])
    assert.throws(() => validatePrivateAction({ action: 'shield', expectedRevision: 'reviewed', amount }));
  assert.throws(() => validatePrivateAction({ action: 'swap', expectedRevision: 'reviewed', amount: '500' }));
  assert.throws(() => validatePrivateAction({ action: 'unshield', expectedRevision: 'reviewed', amount: '1', recipient: '0x' + '0'.repeat(40) }));
  assert.throws(() => validatePrivateAction({ action: 'transfer', amount: '1' }));
});

test('private API inputs cannot select arbitrary commands, RPCs, wallet keys or file paths', () => {
  for (const extra of [{ rpcUrl: 'http://evil.test' }, { command: 'rm' }, { privateKey: 'secret' }, { file: '/tmp/state' }])
    assert.throws(() => validatePrivateAction({ action: 'initialize', ...extra }));
  for (const action of ['deploy arbitrary', 'constructor', '', null]) assert.throws(() => validatePrivateAction({ action }));
  assert.throws(() => validatePrivateAction({ action: 'shield', expectedRevision: 'reviewed', amount: '1', wallet: '../../runtime' }));
});
