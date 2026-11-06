import test from 'node:test';
import assert from 'node:assert/strict';
import { demoOptions } from '../scripts/aqua/options.mjs';

test('Aqua demo can resume its default journal or use a separate named local run', () => {
  assert.deepEqual(demoOptions(['--network', 'local']), { runId: 'default', networkId: 'local' });
  assert.deepEqual(demoOptions(['--network', 'local', '--run', 'final-demo-2']), { runId: 'final-demo-2', networkId: 'local' });
});

test('Aqua demo rejects unsupported networks and run names that could escape its journal directory', () => {
  for (const network of ['public', 'mainnet', 'http://localhost:8545'])
    assert.throws(() => demoOptions(['--network', network]));
  for (const name of ['../maker', '/tmp/demo', '', 'a/b', 'a'.repeat(33)])
    assert.throws(() => demoOptions(['--network', 'local', '--run', name]));
  assert.throws(() => demoOptions(['--network', 'local', '--reset', 'default']));
  assert.throws(() => demoOptions(['--network', 'local', '--run', 'demo', '--network', 'public']));
});

test('Aqua demo isolates the selected remote devnet', () => {
  assert.deepEqual(demoOptions(['--network','devnet']), {runId:'default',networkId:'devnet'});
});
