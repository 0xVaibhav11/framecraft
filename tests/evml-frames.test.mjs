import test from 'node:test';
import assert from 'node:assert/strict';
import { getProfile } from '@framepay/sdk';
import { MAX_FRAMES, prefixLength, refusal, toFrames } from '../apps/web/src/lib/evml-frame-layout.mjs';

const profile = getProfile('ethrex-eip8141-tracer');
const sender = '0x1111111111111111111111111111111111111111';
const paymaster = '0xF13aB1CE9463FAaF2d01b25998F83ecF297Ffc22';
const usd = '0x99A509093EfD7d0345BE614aad951AfC3A81b380';
const asset = '0x55695fe239404ad5f03828e1fDC5C2096c80C1fe';
const budgets = {
  account: { execution: 30_000n, state: 0n },
  payment: { execution: 50_000n, state: 0n },
  eoa: { execution: 600_000n, state: 1_500_000n },
};
// What EVMcrispr's frame:tx returns (commit 1404f73d) for
//   tx --paymaster $paymaster ( batch ( exec $usd "claim()"  exec $asset "claim()" ) )
const sponsoredClaims = [
  { mode: 'verify', approve: 'execution', target: null, data: '0x', value: 0n, gas: 30_000n },
  { mode: 'verify', approve: 'payment', target: paymaster, data: '0x', value: 0n, gas: 50_000n },
  { mode: 'sender', target: usd, data: '0x4e71d92d', value: 0n, atomic: true },
  { mode: 'sender', target: asset, data: '0x4e71d92d', value: 0n },
];
const action = (frames, extra = {}) => ({ type: 'frame', chainId: 1337, from: sender, frames, mempool: 'alt', ...extra });

test('a sponsored frame:tx becomes the SDK frames the gateway expects', () => {
  const { frameModes: m, approveScopes: s, flagBits } = profile;
  assert.deepEqual(toFrames(sponsoredClaims, budgets), [
    { mode: m.VERIFY, flags: s.EXECUTION, target: null, limits: { execution: 30_000n, state: 0n }, value: 0n, data: '0x' },
    { mode: m.VERIFY, flags: s.PAYMENT, target: paymaster, limits: { execution: 50_000n, state: 0n }, value: 0n, data: '0x' },
    { mode: m.SENDER, flags: flagBits.ATOMIC_BATCH, target: usd, limits: { execution: 600_000n, state: 1_500_000n }, value: 0n, data: '0x4e71d92d' },
    { mode: m.SENDER, flags: 0, target: asset, limits: { execution: 600_000n, state: 1_500_000n }, value: 0n, data: '0x4e71d92d' },
  ]);
});

test('written gas wins over budgets, and validation frames never get state gas', () => {
  const frames = toFrames([
    { mode: 'verify', approve: 'both', target: null, data: '0x', value: 0n, gas: 40_000n, stateGas: 9n },
    { mode: 'default', target: usd, data: '0x', value: 0n, gas: 70_000n, stateGas: 80_000n },
    { mode: 'sender', target: asset, data: '0x', value: 5n, gas: 90_000n },
  ], budgets);
  assert.deepEqual(frames.map((f) => [f.mode, f.flags, f.limits.execution, f.limits.state, f.value]), [
    [profile.frameModes.VERIFY, profile.approveScopes.EXECUTION_AND_PAYMENT, 40_000n, 0n, 0n],
    [profile.frameModes.DEFAULT, 0, 70_000n, 80_000n, 0n],
    [profile.frameModes.SENDER, 0, 90_000n, 1_500_000n, 5n],
  ]);
});

test('a pre-verify default frame belongs to the validation prefix', () => {
  const specs = [
    { mode: 'verify', approve: 'execution', target: null, data: '0x', value: 0n, gas: 30_000n },
    { mode: 'default', target: paymaster, data: '0x', value: 0n, gas: 60_000n, stateGas: 1n },
    { mode: 'verify', approve: 'payment', target: paymaster, data: '0x', value: 0n, gas: 50_000n },
    { mode: 'sender', target: usd, data: '0x', value: 0n },
  ];
  assert.equal(prefixLength(specs), 3);
  assert.equal(toFrames(specs, budgets)[1].limits.state, 0n);
});

test('only this page\'s own alt-mempool transactions on chain 1337 are sent', () => {
  assert.equal(refusal(action(sponsoredClaims), sender.toUpperCase().replace('0X', '0x')), undefined);
  assert.match(refusal(action(sponsoredClaims, { chainId: 1 }), sender), /chain 1337/);
  assert.match(refusal(action(sponsoredClaims, { from: usd }), sender), /signs only for its test account/);
  assert.match(refusal(action(sponsoredClaims, { mempool: 'canonical' }), sender), /alt mempool only/);
  // frame:tx --account: a smart account its owner's wallet signs for.
  assert.match(refusal(action(sponsoredClaims, { from: usd, account: { kind: 'frame-account', owner: sender } }), sender), /drop --account/);
  const many = Array.from({ length: MAX_FRAMES + 1 }, () => sponsoredClaims[3]);
  assert.match(refusal(action(many), sender), /at most 16/);
});
