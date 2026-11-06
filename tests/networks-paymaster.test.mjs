import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { frameNetworks } from '@framepay/sdk';
import { handleRpc } from '../apps/poc/src/lib/rpc-handler.mjs';
import { validateGateway } from '../apps/poc/src/lib/rpc-policy.mjs';
import { networkFor, createNetworkRpc, identifyNetwork, waitReceipt, assertDeploymentReceipt } from '../scripts/paymaster/runtime.mjs';

const hash = `0x${'12'.repeat(32)}`;
const blockHash = `0x${'34'.repeat(32)}`;
const address = `0x${'56'.repeat(20)}`;
const request = network => new Request(`http://localhost:3000/api/rpc?network=${network}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
});

test('equal chain IDs retain distinct endpoints and explorer namespaces', () => {
  assert.equal(frameNetworks.local.chainId, frameNetworks.public.chainId);
  assert.notEqual(frameNetworks.local.rpcUrl, frameNetworks.public.rpcUrl);
  assert.notEqual(frameNetworks.local.explorerUrl, frameNetworks.public.explorerUrl);
  assert.throws(() => networkFor('mainnet'));
  assert.throws(() => networkFor('constructor'));
});

test('public RPC routes only to the named gateway regardless of the local override', async () => {
  let calls = 0;
  const response = await handleRpc(request('public'), { gateway: 'http://localhost:9999/rpc', fetchImpl: async (url) => {
    calls++;
    assert.equal(url, frameNetworks.public.rpcUrl);
    return Response.json({ jsonrpc: '2.0', id: 1, result: '0x539' });
  } });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(validateGateway(frameNetworks.public.rpcUrl, 'public'), true);
  for (const url of ['https://altmempoolgateway.forshtat.com.evil.test/rpc', 'http://127.0.0.1/rpc', frameNetworks.public.rpcUrl + '?url=x'])
    assert.equal(validateGateway(url, 'public'), false);
});

test('unknown networks are rejected and public failures never fall back to local', async () => {
  for (const network of ['mainnet', 'constructor', 'http://evil.test']) {
    const response = await handleRpc(request(network), { fetchImpl: () => assert.fail('Unexpected forwarding') });
    assert.equal(response.status, 400);
  }
  let calls = 0;
  const response = await handleRpc(request('public'), { fetchImpl: async () => { calls++; throw new Error('offline'); } });
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
  assert.match(await response.text(), /Public devnet gateway unavailable/);
});

test('deployment identity rejects wrong chains or missing genesis information', async () => {
  await assert.rejects(identifyNetwork(async () => '0x1', frameNetworks.public), /chain ID/);
  await assert.rejects(identifyNetwork(async method => method === 'eth_chainId' ? '0x539' : null, frameNetworks.public), /genesis/);
  assert.equal(await identifyNetwork(async method => method === 'eth_chainId' ? '0x539' : { hash }, frameNetworks.public), hash);
});

test('deployment RPC is one-shot and does not expose raw upstream errors', async () => {
  let calls = 0;
  const rpc = createNetworkRpc(frameNetworks.public, async (url, init) => {
    calls++;
    assert.equal(url, frameNetworks.public.rpcUrl);
    assert.equal(init.redirect, 'error');
    return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'private-key-and-signed-payload' } });
  });
  await assert.rejects(rpc('eth_sendRawTransaction', ['0x00']), error => {
    assert.doesNotMatch(error.message, /private-key|signed-payload/);
    return true;
  });
  assert.equal(calls, 1);
});

test('deployment receipts need a successful status, matching hash and expected contract', async () => {
  const receipt = { transactionHash: hash, blockHash, blockNumber: '0x1', status: '0x1', contractAddress: address };
  assert.deepEqual(await waitReceipt(async () => receipt, hash), receipt);
  assert.doesNotThrow(() => assertDeploymentReceipt(receipt, address));
  assert.throws(() => assertDeploymentReceipt({ ...receipt, status: '0x0' }, address), /reverted/);
  assert.throws(() => assertDeploymentReceipt({ ...receipt, contractAddress: null }, address), /different contract/);
  await assert.rejects(waitReceipt(async () => ({ ...receipt, transactionHash: blockHash }), hash), /mismatched/);
  await assert.rejects(waitReceipt(async () => null, hash, { timeoutMs: 5, intervalMs: 1 }), /saved hash/);
});

test('committed paymaster artifact matches the reviewed contract source', async () => {
  const artifact = JSON.parse(await readFile(new URL('../contracts/artifacts/FramePayPaymaster.json', import.meta.url)));
  const source = await readFile(new URL('../contracts/src/FramePayPaymaster.sol', import.meta.url));
  assert.equal(artifact.sourceSha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(artifact.compiler, '0.8.33+commit.64118f21');
  assert.equal(artifact.helperPackageVersion, '0.0.1');
  assert.match(artifact.bytecode, /^0x[0-9a-f]+$/);
});


test('FramePay devnet uses only the selected tunnel and rejects a changed genesis', async () => {
  assert.equal(validateGateway(frameNetworks.devnet.rpcUrl, 'devnet'), true);
  for (const url of [frameNetworks.devnet.rpcUrl + '?upstream=x', 'https://other.trycloudflare.com/rpc', frameNetworks.local.rpcUrl]) assert.equal(validateGateway(url, 'devnet'), false);
  const response = await handleRpc(request('devnet'), { gateway: frameNetworks.local.rpcUrl, fetchImpl: async url => {
    assert.equal(url, frameNetworks.devnet.rpcUrl);
    return Response.json({jsonrpc:'2.0',id:1,result:'0x539'});
  }});
  assert.equal(response.status, 200);
  await assert.rejects(identifyNetwork(async method => method === 'eth_chainId' ? '0x539' : {hash}, frameNetworks.devnet), /genesis changed/);
  assert.equal(await identifyNetwork(async method => method === 'eth_chainId' ? '0x539' : {hash:frameNetworks.devnet.genesisHash}, frameNetworks.devnet), frameNetworks.devnet.genesisHash);
});
