import test from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { type Hex } from 'viem';
import { quoteExactIn, swapConditions, hex32, localRpcUrl, rpcUrl, requireDevnetChain, makeRpcClient, assertNativeReceipt,
  PrivateTree, makeWallet, shieldRequest, scan, railgunInterface, preparePrivateTransfer, PrivateProver, PrivacyError,
  type RpcClient, type NativeReceipt } from '@framepay/privacy';
import { poseidon } from '../../packages/privacy/dist/engine.js';

const A = '0x0000000000000000000000000000000000000011' as const;
const B = '0x0000000000000000000000000000000000000022' as const;
const quote = { tradeId: hex32(1), deadline: 1000n, payment0: hex32(2), payment1: hex32(3) };

test('exact-in quote matches the bundle and floors small trades', () => {
  assert.equal(quoteExactIn(500n, 1000n, 2000n), 200n);
  assert.equal(quoteExactIn(10n, 100n, 300n), 3n);
  assert.throws(() => quoteExactIn(1n, 1n, 100n));
  assert.throws(() => quoteExactIn(0n, 1n, 1n));
  assert.throws(() => quoteExactIn(1n << 120n, 1n, 1n));
});
test('quote consent binds every settlement domain field', () => {
  const expected = swapConditions(1337n, A, B, quote);
  for (const changed of [
    swapConditions(1338n, A, B, quote), swapConditions(1337n, B, B, quote), swapConditions(1337n, A, A, quote),
    swapConditions(1337n, A, B, { ...quote, tradeId: hex32(9) }),
    swapConditions(1337n, A, B, { ...quote, deadline: 999n }),
    swapConditions(1337n, A, B, { ...quote, payment0: hex32(9) }),
    swapConditions(1337n, A, B, { ...quote, payment1: hex32(9) }),
  ]) assert.notEqual(changed, expected);
  assert.throws(() => swapConditions(1337n, A, B, { ...quote, deadline: 1n << 64n }));
  assert.throws(() => swapConditions(1337n, A, B, { ...quote, payment1: quote.payment0 }));
});
test('private demo rejects remote endpoints and URL credentials', () => {
  for (const url of ['https://example.com/rpc', 'file://localhost/tmp/rpc', 'http://user:secret@localhost/rpc', 'http://127.0.0.1.example.com']) {
    assert.throws(() => localRpcUrl(url));
  }
  assert.equal(localRpcUrl('http://127.0.0.1:14337/rpc'), 'http://127.0.0.1:14337/rpc');
  assert.equal(localRpcUrl('http://[::1]:14337/rpc'), 'http://[::1]:14337/rpc');
});
test('RPC validates IDs and redacts remote error messages', async () => {
  const fetcher = ((_: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { id: number };
    return Promise.resolve(Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'private-witness-secret' } }));
  }) as typeof fetch;
  const rpc = makeRpcClient('http://localhost', fetcher);
  await assert.rejects(rpc.request('eth_call'), (error: unknown) => error instanceof PrivacyError && error.rpcCode === -32000 && !error.message.includes('secret'));
  const wrong = makeRpcClient('http://localhost', (async () => Response.json({ jsonrpc: '2.0', id: 999, result: '0x1' })) as typeof fetch);
  await assert.rejects(wrong.request('eth_chainId'), /mismatched/);
});
test('native receipt validation cannot mistake failed authorization for rollback', () => {
  const receipt: NativeReceipt = { transactionHash: hex32(1), blockNumber: '0x1', type: '0x6', status: '0x1', gasUsed: '0x1', logs: [], frameReceipts: [{ status: '0x1' }, { status: '0x1' }] };
  assertNativeReceipt(receipt);
  assert.throws(() => assertNativeReceipt({ ...receipt, type: '0x2' }));
  assert.throws(() => assertNativeReceipt({ ...receipt, frameReceipts: [] }));
  assert.throws(() => assertNativeReceipt({ ...receipt, frameReceipts: [{ status: '0x0' }, { status: '0x0' }] }, true));
  const failed = { ...receipt, status: '0x0' as Hex, frameReceipts: [{ status: '0x1' as Hex }, { status: '0x0' as Hex }] };
  assertNativeReceipt(failed, true);
  assert.throws(() => assertNativeReceipt(failed));
});
test('real shield encryption is owned only by its recipient and spent notes disappear', async () => {
  let spent = false;
  const rpc: RpcClient = { async request<T>() { return railgunInterface.encodeFunctionResult('nullifiers', [spent]) as T; } };
  const tree = new PrivateTree(rpc, A, '0x0');
  assert.throws(() => tree.getRoot());
  assert.throws(() => tree.getMerkleProof(0, 0));
  const owner = await makeWallet('owner', tree), outsider = await makeWallet('outsider', tree);
  const request = await shieldRequest(owner, B, 10_000n);
  const npk = String(request.preimage.npk), value = 9975n;
  const hash = hex32(poseidon([BigInt(npk), BigInt(B), value]));
  tree.events = [{ kind: 'Shield', position: 0, blockNumber: 1, hash,
    preimage: { npk, token: { tokenType: 0n, tokenAddress: B, tokenSubID: 0n }, value },
    ciphertext: { shieldKey: String(request.ciphertext.shieldKey), encryptedBundle: request.ciphertext.encryptedBundle.map(String) as [string, string, string] } }];
  assert.equal((await scan(owner, tree))[0].note.value, value);
  assert.equal((await scan(outsider, tree)).length, 0);
  spent = true;
  assert.equal((await scan(owner, tree)).length, 0);
});
test('invalid transfer fails in the Effect error channel before the prover runs', async () => {
  const tree = new PrivateTree({ request: async () => { throw new Error('unexpected RPC'); } }, A, '0x0');
  const wallet = await makeWallet('empty-wallet', tree);
  let called = false;
  const program = preparePrivateTransfer(wallet, wallet, B, 1n).pipe(Effect.provideService(PrivateProver, {
    prove: () => { called = true; return Effect.fail(new PrivacyError({ operation: 'test', message: 'not expected' })); },
  }));
  await assert.rejects(Effect.runPromise(program));
  assert.equal(called, false);
});


test('remote RPC requires explicit HTTPS selection and matching genesis', async () => {
  const url = 'https://psi-essential-rebate-wrist.trycloudflare.com/rpc';
  assert.throws(() => rpcUrl(url));
  assert.equal(rpcUrl(url, { allowRemote: true }), url);
  assert.throws(() => rpcUrl('http://example.com/rpc', { allowRemote: true }));
  assert.throws(() => rpcUrl('https://user:secret@example.com/rpc', { allowRemote: true }));
  const rpc: RpcClient = { async request<T>(method: string) { return (method === 'eth_chainId' ? '0x539' : { hash: hex32(1) }) as T; } };
  await Effect.runPromise(requireDevnetChain(rpc, hex32(1)));
  await assert.rejects(Effect.runPromise(requireDevnetChain(rpc, hex32(2))));
});
