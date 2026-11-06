import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, custom, defineChain } from 'viem';
import { createFrameClient, frameActions, frame, getProfile, privateKeyToFrameSigner, txHash, FramePayError } from '@framepay/sdk';

const chain = defineChain({ id: 1337, name: 'Test fixture', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://localhost:14337/rpc'] } } });
const profile = getProfile('ethrex-eip8141-tracer');
// Public deterministic test key. No real participant state is read by these SDK tests.
const signer = privateKeyToFrameSigner(`0x${'0'.repeat(63)}1`);
const recipient = '0x8943545177806ED17B9F23F0a21ee5948eCaa776';
const hash = `0x${'ab'.repeat(32)}`;
const blockHash = `0x${'cd'.repeat(32)}`;
const parameters = () => ({
  sender: signer.address, maxFeePerGas: 2_000_000_000n,
  frames: [
    frame(profile, 'VERIFY', { scope: 'EXECUTION_AND_PAYMENT', execution: 30_000n }),
    frame(profile, 'SENDER', { target: recipient, execution: 50_000n, state: 200_000n, value: 1n }),
  ],
});
const receipt = (transactionHash = hash) => ({ transactionHash, blockHash, blockNumber: '0x43', status: '0x1', frameReceipts: [{ status: '0x1' }, { status: '0x1' }] });
function setup(responder = async () => null, extension = false) {
  const calls = [];
  const transport = custom({ async request(request) {
    calls.push(structuredClone(request));
    if (request.method === 'eth_chainId') return '0x539';
    if (request.method === 'eth_getTransactionCount') return '0x7';
    return responder(request);
  } }, { retryCount: 3, retryDelay: 1 });
  const client = extension ? createPublicClient({ chain, transport }).extend(frameActions({ profile: profile.id }))
    : createFrameClient({ chain, transport, profile: profile.id });
  return { client, calls };
}

test('public viem extension supports prepare/sign/send/receipt/admission using the actual codec', async () => {
  let expectedHash;
  const { client, calls } = setup(async ({ method, params }) => {
    if (method === 'eth_sendFrameTransaction') {
      assert.equal(params[0].chainId, '0x539');
      assert.equal(params[0].nonceSeq, '0x7');
      assert.equal(params[0].frames[1].value, '0x1');
      assert.doesNotThrow(() => JSON.stringify(params));
      return expectedHash;
    }
    if (method === 'eth_getTransactionReceipt') return receipt(expectedHash);
    if (method === 'skandha_explorer_getTransaction') return { hash: expectedHash, admission: { txHash: expectedHash, outcome: 'included', checks: [{ rule: 'signature', verdict: 'pass' }] } };
    throw new Error('Unexpected method');
  }, true);
  const prepared = await client.prepareFrameTransaction(parameters());
  const signed = await client.signFrameTransaction({ transaction: prepared, signer });
  expectedHash = txHash(profile, signed);
  assert.equal(await client.sendFrameTransaction({ transaction: signed }), expectedHash);
  const result = await client.waitForFrameReceipt({ hash: expectedHash, expectedFrameCount: 2 });
  assert.equal(result.status, '0x1');
  assert.equal((await client.getFrameAdmission({ hash: expectedHash })).outcome, 'included');
  assert.equal(calls.filter(({ method }) => method === 'eth_sendFrameTransaction').length, 1);
  assert.equal(prepared.signatures[0].signature, '0x');
});

test('wrong chain is rejected before a prepare or submission reaches the configured method', async () => {
  const calls = [];
  const client = createFrameClient({ chain, profile: profile.id, transport: custom({ async request({ method }) { calls.push(method); return '0x1'; } }) });
  await assert.rejects(client.prepareFrameTransaction(parameters()), { code: 'CHAIN_MISMATCH' });
  assert.deepEqual(calls, ['eth_chainId']);
});

test('keyed nonce preparation never silently uses the ordinary account nonce', async () => {
  const { client, calls } = setup();
  await assert.rejects(client.prepareFrameTransaction({ ...parameters(), nonceKeys: [1n] }), /nonceSeq explicitly/);
  assert.equal(calls.length, 0);
  const prepared = await client.prepareFrameTransaction({ ...parameters(), nonceKeys: [1n, 2n], nonceSeq: 0n });
  assert.deepEqual(prepared.nonceKeys, [1n, 2n]);
  assert.equal(prepared.nonceSeq, 0n);
  assert.equal(calls.some(({ method }) => method === 'eth_getTransactionCount'), false);
});

test('a signer cannot change the authorized recipient, and a mismatched self-signing account fails', async () => {
  const { client } = setup();
  const prepared = await client.prepareFrameTransaction(parameters());
  const malicious = { address: signer.address, async sign({ transaction }) { transaction.frames[1].target = signer.address; return transaction; } };
  await assert.rejects(client.signFrameTransaction({ transaction: prepared, signer: malicious }), { code: 'SIGNER_MUTATION' });
  assert.equal(prepared.frames[1].target, recipient);
  const wrongSigner = privateKeyToFrameSigner(`0x${'0'.repeat(63)}2`);
  await assert.rejects(client.signFrameTransaction({ transaction: prepared, signer: wrongSigner }), /Signer does not match/);
});

test('submission snapshots the signed envelope before asynchronous chain checks', async () => {
  let expectedHash;
  const { client } = setup(async ({ method, params }) => {
    if (method === 'eth_sendFrameTransaction') {
      assert.equal(params[0].frames[1].value, '0x1');
      return expectedHash;
    }
    return null;
  });
  const prepared = await client.prepareFrameTransaction(parameters());
  const signed = await client.signFrameTransaction({ transaction: prepared, signer });
  expectedHash = txHash(profile, signed);
  const pending = client.sendFrameTransaction({ transaction: signed });
  signed.frames[1].value = 999n;
  assert.equal(await pending, expectedHash);
});

test('a retriable write error is not resubmitted and retains the hash without exposing RPC payloads', async () => {
  let writes = 0;
  const { client } = setup(async () => {
    writes++;
    throw Object.assign(new Error('PRIVATE_REQUEST_BODY'), { code: -32005 });
  });
  const transaction = await client.signFrameTransaction({ transaction: await client.prepareFrameTransaction(parameters()), signer });
  await assert.rejects(client.sendFrameTransaction({ transaction }), (error) => {
    assert.ok(error instanceof FramePayError);
    assert.equal(error.code, 'RPC_ERROR');
    assert.equal(error.context.transactionHash, txHash(profile, transaction));
    assert.equal(error.message.includes('PRIVATE_REQUEST_BODY'), false);
    return true;
  });
  assert.equal(writes, 1);
});

test('failed frames, ordinary receipts, and mismatched hashes cannot report successful execution', async () => {
  const failed = { ...receipt(), frameReceipts: [{ status: '0x1' }, { status: '0x0' }] };
  const { client } = setup(async () => failed);
  await assert.rejects(client.waitForFrameReceipt({ hash }), (error) => {
    assert.equal(error.code, 'FRAME_REVERTED');
    assert.deepEqual(error.context.failedFrameIndices, [1]);
    return true;
  });
  const ordinary = setup(async () => ({ ...receipt(), frameReceipts: undefined })).client;
  await assert.rejects(ordinary.waitForFrameReceipt({ hash }), { code: 'INVALID_RESPONSE' });
  const wrong = setup(async () => receipt(`0x${'ee'.repeat(32)}`)).client;
  await assert.rejects(wrong.waitForFrameReceipt({ hash }), { code: 'INVALID_RESPONSE' });
});

test('receipt timeout is distinct from rejection and an aborted wait sends no requests', async () => {
  const { client, calls } = setup();
  await assert.rejects(client.waitForFrameReceipt({ hash, timeoutMs: 5, pollingIntervalMs: 1 }), { code: 'RECEIPT_TIMEOUT' });
  const controller = new AbortController();
  controller.abort();
  const count = calls.length;
  await assert.rejects(client.waitForFrameReceipt({ hash, signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(calls.length, count);
});

test('timeout and cancellation stop waiting even when the underlying read never returns', async () => {
  const { client } = setup(async () => new Promise(() => {}));
  await assert.rejects(client.waitForFrameReceipt({ hash, timeoutMs: 10 }), { code: 'RECEIPT_TIMEOUT' });
  const controller = new AbortController();
  const waiting = client.waitForFrameReceipt({ hash, signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(waiting, { code: 'ABORTED' });
});

test('unsigned requests are blocked and custom signer errors do not leak signing inputs', async () => {
  const { client, calls } = setup();
  const transaction = await client.prepareFrameTransaction(parameters());
  const before = calls.length;
  await assert.rejects(client.sendFrameTransaction({ transaction }), { code: 'INVALID_TRANSACTION' });
  assert.equal(calls.length, before);
  const failingSigner = { address: signer.address, async sign() { throw new Error('SECRET_SIGNING_INPUT'); } };
  await assert.rejects(client.signFrameTransaction({ transaction, signer: failingSigner }), (error) => {
    assert.equal(error.code, 'SIGNING_FAILED');
    assert.equal(error.message.includes('SECRET_SIGNING_INPUT'), false);
    return true;
  });
});

test('missing retained admission history is not reported as a rejection', async () => {
  const { client } = setup(async () => ({ hash, admission: null }));
  const report = await client.getFrameAdmission({ hash });
  assert.equal(report.available, false);
  assert.equal(report.outcome, null);
});

test('malformed admission records are rejected; failed rule IDs are preserved', async () => {
  const bad = setup(async () => ({ hash, admission: { txHash: hash, outcome: 'invented', checks: [] } })).client;
  await assert.rejects(bad.getFrameAdmission({ hash }), { code: 'INVALID_RESPONSE' });
  const good = setup(async () => ({ hash, admission: { txHash: hash, outcome: 'rejected', checks: [{ rule: 'storage', verdict: 'fail', frameIndex: 0 }] } })).client;
  const result = await good.getFrameAdmission({ hash });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.checks[0].rule, 'storage');
});
