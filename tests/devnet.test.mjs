import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  root, loadConfig, validateConfig, checkPins, loadCodec, buildSmokeTx, createRpc,
  probeGateway, assertFrameReceipt, waitForReceipt, getAdmissionEvidence, safeError,
} from '../scripts/devnet/runtime.mjs';

const cfg = await loadConfig();
const hash = `0x${'ab'.repeat(32)}`;
const receipt = () => ({
  transactionHash: hash, blockHash: `0x${'cd'.repeat(32)}`, blockNumber: '0x43',
  status: '0x1', frameReceipts: [{ status: '0x1' }, { status: '0x1' }],
});

test('error reports redact values shaped like participant private keys', () => {
  const fixture = `0x${'a1'.repeat(32)}`;
  const report = safeError(new Error(`invalid signing input ${fixture}`));
  assert.equal(report.message.includes(fixture), false);
  assert.match(report.message, /redacted/);
});

test('the installed public codec and local setup still match recorded source fingerprints', async () => {
  const pins = await checkPins(cfg);
  assert.equal(pins.verified, true, JSON.stringify(pins.checks.filter((entry) => !entry.matches)));
});

test('configuration rejects remote/credentialed gateways and unexpected spending bounds', () => {
  for (const gatewayUrl of ['https://example.com/rpc', 'http://localhost.example.com/rpc', 'http://secret@localhost:14337/rpc', 'file:///tmp/rpc']) {
    assert.throws(() => validateConfig({ ...cfg, gatewayUrl }));
  }
  assert.throws(() => validateConfig({ ...cfg, chainId: 1 }), /chain\/profile/);
  assert.throws(() => validateConfig({ ...cfg, transferWei: '1000000001' }), /1 gwei/);
  assert.throws(() => validateConfig({ ...cfg, maxFeePerGasWei: '2000000001' }), /2 gwei/);
});

test('wrong-chain response stops preflight before further RPC calls', async () => {
  const methods = [];
  await assert.rejects(probeGateway(cfg, async (method) => { methods.push(method); return '0x1'; }), /Wrong chain/);
  assert.deepEqual(methods, ['eth_chainId']);
});

test('a responding chain with no registry or wrong explorer chain is not compatible', async () => {
  const respond = async (method) => ({
    eth_chainId: '0x539', web3_clientVersion: 'test-client',
    eth_getBlockByNumber: { hash, number: '0x43' },
    skandha_explorer_info: { chainId: 1337 }, eth_getCode: '0x',
  })[method];
  await assert.rejects(probeGateway(cfg, respond), /registry/);
  await assert.rejects(probeGateway(cfg, async (method) => method === 'skandha_explorer_info'
    ? { chainId: 1 } : respond(method)), /Explorer chain/);
});

test('missing, failed, and mismatched frame receipts cannot report success', () => {
  assertFrameReceipt(receipt(), hash);
  assert.throws(() => assertFrameReceipt({ ...receipt(), status: '0x0' }, hash), /execution failed/);
  assert.throws(() => assertFrameReceipt({ ...receipt(), frameReceipts: undefined }, hash), /frame receipts/);
  assert.throws(() => assertFrameReceipt({ ...receipt(), frameReceipts: [] }, hash), /frame receipts/);
  assert.throws(() => assertFrameReceipt({ ...receipt(), frameReceipts: [{ status: '0x1' }, { status: '0x0' }] }, hash), /frames failed/);
  assert.throws(() => assertFrameReceipt(receipt(), `0x${'ff'.repeat(32)}`), /hash mismatch/);
});

test('receipt polling distinguishes pending from mined, and stops on a failed frame', async () => {
  let calls = 0;
  const result = await waitForReceipt(async () => ++calls === 1 ? null : receipt(), hash, { ...cfg, pollIntervalMs: 1 });
  assert.equal(result.blockNumber, '0x43');
  assert.equal(calls, 2);
  await assert.rejects(waitForReceipt(async () => ({ ...receipt(), status: '0x0' }), hash, cfg), /execution failed/);
  await assert.rejects(waitForReceipt(async () => null, hash, { ...cfg, receiptTimeoutMs: 5, pollIntervalMs: 1 }), /Inclusion timeout/);
});

test('RPC envelope validation and sanitized errors prevent false success or echoed payloads', async () => {
  const responder = (body) => async () => ({ ok: true, json: async () => body });
  await assert.rejects(createRpc(cfg, responder({ jsonrpc: '2.0', id: 99, result: '0x539' }))('eth_chainId'), /Invalid JSON-RPC/);
  await assert.rejects(createRpc(cfg, responder({ jsonrpc: '2.0', id: 1 }))('eth_chainId'), /Missing RPC result/);
  await assert.rejects(createRpc(cfg, responder({ jsonrpc: '2.0', id: 1, error: { code: -32502, message: 'DO_NOT_EXPORT_REQUEST_BODY' } }))('eth_sendFrameTransaction'), (error) => {
    assert.equal(error.code, -32502);
    assert.equal(error.message.includes('DO_NOT_EXPORT_REQUEST_BODY'), false);
    return true;
  });
  await assert.rejects(createRpc(cfg, async () => { throw new Error('socket denied'); })('eth_chainId'), { code: 'RPC_UNREACHABLE' });
});

test('admission evidence must match the transaction and an accepted outcome', async () => {
  const detail = { hash, admission: { txHash: hash, outcome: 'included', checks: [{ rule: 'signature', verdict: 'pass' }] }, events: [] };
  assert.equal((await getAdmissionEvidence(async () => detail, hash)).outcome, 'included');
  await assert.rejects(getAdmissionEvidence(async () => ({ ...detail, admission: null }), hash), /Missing admission/);
  await assert.rejects(getAdmissionEvidence(async () => ({ ...detail, admission: { ...detail.admission, outcome: 'rejected' } }), hash), /accepted\/included/);
  const rejection = { ...detail, admission: { ...detail.admission, outcome: 'rejected', checks: [{ rule: 'storage', verdict: 'fail' }] } };
  const report = await getAdmissionEvidence(async () => rejection, hash, { requireAccepted: false });
  assert.equal(report.outcome, 'rejected');
  assert.equal(report.checks[0].rule, 'storage');
  assert.equal(report.checks[0].verdict, 'fail');
});

test('official codec produces a valid signer and binds recipient, nonce, and gas limits', async () => {
  const codec = await loadCodec(cfg);
  const require = createRequire(resolve(root, cfg.workshopPath, 'package.json'));
  const { recoverAddress, keccak256 } = require('viem');
  // Public deterministic test fixture, never the participant's key.
  const key = `0x${'0'.repeat(63)}1`;
  const sender = codec.accounts.privateKeyToAccount(key).address;
  const signed = await codec.tx.signTx(codec.profile, buildSmokeTx(codec, cfg, sender, 7n), key);
  const packed = signed.signatures[0].signature;
  const signature = {
    r: `0x${packed.slice(4, 68)}`, s: `0x${packed.slice(68, 132)}`,
    v: BigInt(parseInt(packed.slice(2, 4), 16) + 27),
  };
  const signingHash = codec.tx.sigHash(codec.profile, signed);
  assert.equal(await recoverAddress({ hash: signingHash, signature }), sender);
  for (const altered of [
    { ...signed, nonceSeq: 8n },
    { ...signed, frames: signed.frames.map((f, i) => i === 1 ? { ...f, target: sender } : f) },
    { ...signed, fees: { ...signed.fees, maxFeePerGas: signed.fees.maxFeePerGas + 1n } },
  ]) {
    const alteredHash = codec.tx.sigHash(codec.profile, altered);
    assert.notEqual(alteredHash, signingHash);
    assert.notEqual(await recoverAddress({ hash: alteredHash, signature }), sender);
  }
  const encoded = codec.tx.encodeTx(codec.profile, signed);
  assert.ok(encoded.startsWith('0x06'));
  assert.equal(codec.tx.txHash(codec.profile, signed), keccak256(encoded));
  const decoded = codec.tx.decodeTx(codec.profile, encoded);
  assert.equal(decoded.nonceSeq, 7n);
  assert.equal(decoded.frames[1].value, BigInt(cfg.transferWei));
  assert.ok(decoded.frames[1].limits.state > 0n);
  const wire = codec.wire.toWire(signed);
  assert.doesNotThrow(() => JSON.stringify(wire));
  assert.equal(wire.chainId, '0x539');
  assert.equal(wire.frames[1].value, '0x3b9aca00');
});
