import test from 'node:test';
import assert from 'node:assert/strict';
import { custom, defineChain } from 'viem';
import { buildTransferPlan, createFrameClient, getProfile, privateKeyToFrameSigner, sigHash, txHash } from '@framepay/sdk';
import { validateRpcRequest } from '../apps/web/src/lib/rpc-policy.mjs';

const profile = getProfile('ethrex-eip8141-tracer');
const signer = privateKeyToFrameSigner(`0x${'0'.repeat(63)}1`);
const recipient = `0x${'12'.repeat(20)}`;
const sponsor = `0x${'34'.repeat(20)}`;
const other = `0x${'56'.repeat(20)}`;
const parameters = (payment = { type: 'self' }) => ({
  sender: signer.address, transfer: { to: recipient, value: 1n }, payment,
  rules: { allowedRecipients: [recipient], maxValue: 5n, maxFeePerGas: 2_000_000_000n },
  maxFeePerGas: 2_000_000_000n,
});
const build = (p) => buildTransferPlan({ ...p, profile: profile.id });
function setup(overrides = {}) {
  const calls = [];
  const client = createFrameClient({
    profile: profile.id,
    chain: defineChain({ id: 1337, name: 'Fixture', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://localhost'] } } }),
    transport: custom({ async request({ method, params }) {
      calls.push({ method, params });
      if (overrides[method]) return overrides[method](params);
      if (method === 'eth_chainId') return '0x539';
      if (method === 'eth_getCode') return params[0] === sponsor ? '0x6000' : '0x';
      if (method === 'eth_getBalance') return '0x100000000000';
      if (method === 'eth_getTransactionCount') return '0x0';
      throw new Error('Unexpected RPC');
    } }),
  });
  return { client, calls };
}

test('transfer plans separate account execution approval from sponsor payment approval', () => {
  const self = build(parameters());
  assert.equal(self.parameters.frames.length, 2);
  assert.equal(self.parameters.frames[0].flags, profile.approveScopes.EXECUTION_AND_PAYMENT);
  assert.equal(self.summary.payer, signer.address);
  const sponsored = build(parameters({ type: 'paymaster', address: sponsor, verificationData: '0x1234' }));
  const [account, payment, transfer] = sponsored.parameters.frames;
  assert.equal(account.flags, profile.approveScopes.EXECUTION);
  assert.equal(payment.flags, profile.approveScopes.PAYMENT);
  assert.equal(payment.target, sponsor);
  assert.equal(payment.data, '0x1234');
  assert.equal(transfer.target, recipient);
  assert.equal(transfer.value, 1n);
  assert.equal(sponsored.summary.sponsorship, 'unconfirmed');
  assert.equal(sponsored.summary.rulesEnforcement, 'local-draft-only');
});

test('recipient, amount and gas-price limits reject drafts before any RPC', async () => {
  const { client, calls } = setup();
  for (const mutate of [
    p => p.transfer.to = other,
    p => p.transfer.value = 6n,
    p => p.transfer.value = -1n,
    p => p.maxFeePerGas = 2_000_000_001n,
    p => p.rules.allowedRecipients = [],
    p => p.payment = { type: 'paymaster', address: signer.address },
    p => p.payment = { type: 'paymaster', address: sponsor, verificationData: '0x1' },
    p => p.payment = { type: 'paymaster', address: sponsor, verificationGas: { execution: 0n, state: 0n } },
  ]) {
    const p = parameters(); mutate(p);
    await assert.rejects(client.prepareTransfer(p), { code: 'INVALID_TRANSACTION' });
  }
  assert.equal(calls.length, 0);
});

test('a sponsored zero-value transfer can prepare and sign with a zero-ETH sender', async () => {
  const { client, calls } = setup({ eth_getBalance: () => '0x0' });
  const p = parameters({ type: 'paymaster', address: sponsor });
  p.transfer.value = 0n;
  const tx = await client.prepareTransfer(p);
  const signed = await client.signFrameTransaction({ transaction: tx, signer });
  assert.equal(signed.frames.length, 3);
  assert.equal(signed.signatures[0].signature.length, 132);
  assert(calls.every(({ method }) => !method.startsWith('eth_send')));
  const original = sigHash(profile, signed);
  const changed = structuredClone(signed);
  changed.frames[1].target = other;
  assert.notEqual(sigHash(profile, changed), original);
  changed.frames[1].target = sponsor;
  changed.frames[2].value = 2n;
  assert.notEqual(sigHash(profile, changed), original);
});

test('sponsorship does not supply the ETH transfer value and self-payment needs gas funds', async () => {
  const { client } = setup({ eth_getBalance: () => '0x0' });
  await assert.rejects(client.prepareTransfer(parameters({ type: 'paymaster', address: sponsor })), /Sponsorship covers gas only/);
  const self = parameters(); self.transfer.value = 0n;
  await assert.rejects(client.prepareTransfer(self), /ETH for gas/);
});

test('transfer preflight rejects wrong chains, non-contract paymasters and contract transfer targets', async () => {
  const p = parameters({ type: 'paymaster', address: sponsor });
  const wrong = setup({ eth_chainId: () => '0x1' });
  await assert.rejects(wrong.client.prepareTransfer(p), { code: 'CHAIN_MISMATCH' });
  assert.equal(wrong.calls.length, 1);
  await assert.rejects(setup({ eth_getCode: () => '0x' }).client.prepareTransfer(p), /No deployed contract/);
  await assert.rejects(setup({ eth_getCode: () => '0x6000' }).client.prepareTransfer(p), /plain EOA/);
});

test('transfer preparation snapshots user choices before asynchronous preflight', async () => {
  const { client } = setup();
  const p = parameters({ type: 'paymaster', address: sponsor });
  const pending = client.prepareTransfer(p);
  p.transfer.to = other;
  p.transfer.value = 999n;
  p.payment.address = other;
  const tx = await pending;
  assert.equal(tx.frames[1].target, sponsor);
  assert.equal(tx.frames[2].target, recipient);
  assert.equal(tx.frames[2].value, 1n);
});

test('generated sponsored frames submit through the existing SDK without changing authorization', async () => {
  let expected;
  const { client, calls } = setup({ eth_sendFrameTransaction: ([wire]) => {
    assert.equal(wire.frames.length, 3);
    assert.equal(wire.frames[1].target, sponsor);
    assert.equal(validateRpcRequest({ jsonrpc: '2.0', id: 1, method: 'eth_sendFrameTransaction', params: [wire] }), true);
    return expected;
  } });
  const tx = await client.prepareTransfer(parameters({ type: 'paymaster', address: sponsor }));
  const signed = await client.signFrameTransaction({ transaction: tx, signer });
  expected = txHash(profile, signed);
  assert.equal(await client.sendFrameTransaction({ transaction: signed }), expected);
  assert.equal(calls.filter(({ method }) => method === 'eth_sendFrameTransaction').length, 1);
});
