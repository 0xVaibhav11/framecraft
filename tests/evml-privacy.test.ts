import { privateTokens } from '../apps/web/src/lib/privacy/assets';
import { privateKeyToFrameSigner, txHash, type FrameSigner } from '@framepay/sdk';
import type { PrivateScriptWallet } from '../apps/web/src/lib/privacy/runtime';
import { privateFrameRequests, privateFrameContext, materializePrivateFrames } from '../apps/web/src/lib/privacy/frame-plan';
import { toFrames, frameBudgets } from '../apps/web/src/lib/evml-frame-layout.mjs';
import { isPrivateFrameData } from '../apps/web/src/lib/privacy/frame-intent.mjs';
import type { FrameAction } from '@evmcrispr/sdk';
import type { BrowserPrivateResult } from '../scripts/private/browser/types';
import { decodeFunctionData } from 'viem';
import { quantumWalletAbi } from '@framepay/sdk';
import { quantumChallenge } from '@framepay/sdk';
import type { BrowserPrivateSnapshot } from '../scripts/private/browser/types';
import type { ActionHandlerCtx } from '@evmcrispr/core';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEvml } from '@evmcrispr/core';
import Frame from '@evmcrispr/module-frame';
import Privacy from '../apps/web/src/lib/privacy/module';
import { PRIVATE_METHOD, validatePrivateIntent } from '../apps/web/src/lib/privacy/requests';
import { collectPrivatePockets } from '../scripts/private/browser/pockets';
import { privateAuthorizationArgs, PrivateScriptRuntime, parsePrivateWallet } from '../apps/web/src/lib/privacy/runtime';

const sender = '0x1111111111111111111111111111111111111111';
const evml = createEvml({ account: sender, chainId: 1337 }).use(Privacy, Frame);
async function interpret(source: string) { return evml.script(`load privacy\n${source}`).interpret(); }

test('all private commands interpret to deferred wallet intents without proof generation or signing', async () => {
  const actions = await interpret(`privacy:scan
privacy:shield A "10" --wallet maker
privacy:transfer A "1.25" taker
privacy:add-inventory B "2"
privacy:remove-inventory A "0.5"
privacy:swap "0.1" --expect "0.05" --wallet taker
privacy:unshield B "1" "${sender}" --wallet inventory
privacy:quote "0.1"
privacy:lock`);
  assert.equal(actions.length, 9);
  for (const action of actions) { assert.equal(action.type, 'wallet'); assert.equal(action.method, PRIVATE_METHOD); }
  assert.deepEqual(actions[2].params[0], { action: 'transfer', wallet: 'maker', receiver: 'taker', token: 'A', amount: '1.25' });
  assert.equal(actions[3].params[0].receiver, 'inventory');
  assert.equal(actions[4].params[0].wallet, 'inventory');
  assert.equal(actions[5].params[0].token, 'B');
  assert.equal(actions[5].params[0].expectedOutput, '0.05');
  assert.equal(actions[6].params[0].recipient, sender);
});

test('EVML variables and selective imports work with privacy commands', async () => {
  const actions = await evml.script('load privacy [transfer]\nset $amount "0.125"\ntransfer B $amount maker --wallet taker').interpret();
  assert.equal(actions[0].params[0].amount, '0.125');
  assert.equal(actions[0].params[0].wallet, 'taker');
});

test('external private recipients are preserved for worker address/chain validation', async () => {
  const address = `0zk${'a'.repeat(80)}`;
  const actions = await interpret(`privacy:transfer A "1" "${address}"`);
  assert.equal(actions[0].params[0].privateRecipient, address);
});

test('reject invalid amounts, recipients, pockets, unknown options and unbound swap output', async () => {
  for (const script of [
    'privacy:shield A "0"', 'privacy:shield A "10001"', 'privacy:shield A "0.0000000000000000001"',
    'privacy:shield C "1"', 'privacy:transfer A "1" maker', 'privacy:transfer A "1" "bad address"',
    'privacy:shield A "1" --wallet "BadPocket"', 'privacy:shield A "1" --typo maker',
    'privacy:swap "1"', 'privacy:swap "1" --expect "1" --wallet inventory',
    'privacy:unshield A "1" "0x0000000000000000000000000000000000000000"',
  ]) await assert.rejects(() => interpret(script), undefined, script);
});

test('private batch commands require frame:tx, and read-only commands stay outside it', async () => {
  await assert.rejects(() => interpret('batch (\n privacy:shield A "1"\n)'));
  for (const command of ['scan', 'quote "1"', 'lock'])
    await assert.rejects(() => interpret(`load frame\nframe:tx (\n privacy:${command}\n)`));
});

test('reject a different EVML chain before producing private actions', async () => {
  await assert.rejects(() => createEvml({ chainId: 1, account: sender }).use(Privacy).script('load privacy\nprivacy:scan').interpret(), /devnet/);
});

test('execution waits for each command handler and stops after a failure', async () => {
  const seen: string[] = [];
  await assert.rejects(() => evml.script('load privacy\nprivacy:scan\nprivacy:shield A "1"\nprivacy:transfer A "1" taker').execute(undefined, {
    prepareChains: false, handlers: { wallet: async action => {
      const intent = validatePrivateIntent(action.params[0]); seen.push(intent.action);
      if (intent.action === 'shield') throw new Error('proof failed');
    } },
  }), /proof failed/);
  assert.deepEqual(seen, ['scan', 'shield']);
});

test('host revalidates malformed private wallet requests', () => {
  for (const input of [null, {}, { action: 'drain' }, { action: 'swap', amount: '1' }, { action: 'shield', token: 'C', amount: '1' }])
    assert.throws(() => validatePrivateIntent(input));
});

test('wallet import rejects wrong origin/domain and secret-only exports', () => {
  assert.throws(() => parsePrivateWallet({ privateKey: 'not wallet metadata' }, 'https://example.com'));
  assert.throws(() => parsePrivateWallet({ address: sender, factory: sender, networkDomain: '0x00', origin: 'https://elsewhere.com' }, 'https://example.com'));
});

test('private authorization binds exact calls, owner, chain domain, nonce and deadline', () => {
  const wallet = { address: sender, networkDomain: `0x${'01'.repeat(32)}` } as const;
  const calls = [{ to: sender, data: '0x1234' as const }];
  const nonce = 1n, deadline = 2_000_000_000;
  const challenge = quantumChallenge({ chainId: 1337n, wallet: sender, networkDomain: wallet.networkDomain, nonce, deadline: BigInt(deadline), calls: calls.map(c => ({ target: c.to, data: c.data, value: 0n })) });
  const result = { calls, deadline, snapshot: {} as BrowserPrivateSnapshot,
    authorization: { owner: sender, networkDomain: wallet.networkDomain, nonce, challenge, proof: { falconSalt: '0x00' as const, falconSignature: [1n] } } };
  assert.equal(privateAuthorizationArgs(wallet, result)[1], nonce);
  for (const changed of [
    { ...result, authorization: undefined },
    { ...result, calls: [] },
    { ...result, calls: [{ to: sender, data: '0xabcd' as const }] },
    { ...result, deadline: deadline + 1 },
    { ...result, authorization: { ...result.authorization, nonce: 2n } },
    { ...result, authorization: { ...result.authorization, owner: `0x${'22'.repeat(20)}` as const } },
    { ...result, authorization: { ...result.authorization, networkDomain: `0x${'02'.repeat(32)}` as const } },
  ]) assert.throws(() => privateAuthorizationArgs(wallet, changed));
});

test('private host refuses other networks, arbitrary wallet methods, aborted and pending spends', async () => {
  const runtime = new PrivateScriptRuntime(() => {}, () => {});
  const signer = { address: sender, sign: async () => { throw new Error('Signing must not run'); } };
  const ctx = { onLog: () => {} } as ActionHandlerCtx;
  const action = { type: 'wallet' as const, method: PRIVATE_METHOD, params: [{ action: 'scan', wallet: 'maker', receiver: 'taker', token: 'A' }] };
  await assert.rejects(() => runtime.handler('public', signer)(action, ctx), /Select Framecraft/);
  await assert.rejects(() => runtime.handler('devnet', signer)({ ...action, method: 'eth_sign' }, ctx), /only supports privacy/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => runtime.handler('devnet', signer)(action, { ...ctx, signal: controller.signal }));
  runtime.state.pending = { hash: `0x${'ab'.repeat(32)}`, frameCount: 3 };
  await assert.rejects(() => runtime.handler('devnet', signer)(action, ctx), /Inspect pending/);
});

test('restoring an invalid wallet cannot discard an unresolved submission', () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const pending = { hash: `0x${'ab'.repeat(32)}`, frameCount: 3 };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => JSON.stringify(key.endsWith(':pending') ? pending : { invalid: true }) } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://example.com' } });
  try {
    const runtime = new PrivateScriptRuntime(() => {}, () => {});
    assert.throws(() => runtime.restore());
    assert.deepEqual(runtime.state.pending, pending);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else delete globalThis.localStorage;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation); else delete globalThis.location;
  }
});

async function composed(source: string): Promise<FrameAction> {
  const actions = await interpret(`load frame
${source}`);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'frame');
  return actions[0] as FrameAction;
}
function proofResults(action: FrameAction): BrowserPrivateResult {
  const wallet = { address: sender, networkDomain: `0x${'01'.repeat(32)}` as const };
  const batches = privateFrameRequests(action).map((_, i) => {
    const nonce = 10n + BigInt(i), deadline = 2_000_000_000;
    const calls = [{ to: `0x${'22'.repeat(20)}` as const, data: '0x1234' as const }];
    const challenge = quantumChallenge({ chainId: 1337n, wallet: sender, networkDomain: wallet.networkDomain, nonce, deadline: BigInt(deadline), calls: calls.map(c => ({ target: c.to, data: c.data, value: 0n })) });
    return { snapshot: {} as BrowserPrivateSnapshot, calls, deadline,
      authorization: { owner: sender, networkDomain: wallet.networkDomain, nonce, challenge,
        proof: { falconSalt: `0x${'ab'.repeat(40)}` as const, falconSignature: Array(32).fill(1n) } } };
  });
  return { snapshot: {} as BrowserPrivateSnapshot, calls: [], batches, frameContext: privateFrameContext(action) };
}

test('mixed public and private frame blocks stay one deferred alt-mempool action', async () => {
  const action = await composed(`frame:tx --paymaster 0x2222222222222222222222222222222222222222 (
    exec 0x3333333333333333333333333333333333333333 "claim()"
    privacy:transfer A "1" taker
    privacy:swap "0.1" --expect "0.05"
    exec 0x4444444444444444444444444444444444444444 "claim()"
  )`);
  assert.equal(action.mempool, 'alt');
  assert.equal(action.frames.length, 6);
  assert.deepEqual(privateFrameRequests(action).map(r => r.action), ['transfer', 'swap']);
  assert.equal(action.frames[2].target, '0x3333333333333333333333333333333333333333');
  assert.equal(action.frames[5].target, '0x4444444444444444444444444444444444444444');
  assert.throws(() => toFrames(action.frames, frameBudgets), /before serialization/);
});

test('materialization preserves public frames and atomic boundaries and uses consecutive wallet nonces', async () => {
  const action = await composed(`frame:tx --state-gas 7000000 (
 batch (
    privacy:transfer A "1" taker
    exec 0x3333333333333333333333333333333333333333 "claim()"
    privacy:unshield B "1" "${sender}"
  )
)`);
  const result = proofResults(action);
  const resolved = materializePrivateFrames(action, { address: sender, networkDomain: `0x${'01'.repeat(32)}` }, result);
  assert.equal(resolved.length, 4);
  assert.deepEqual(resolved[0], action.frames[0]);
  assert.deepEqual(resolved[2], action.frames[2]);
  assert.deepEqual(resolved.map(f => !!f.atomic), [false, true, true, false]);
  assert.equal(resolved[1].stateGas, 7000000n);
  assert.equal(resolved[3].stateGas, 7000000n);
  for (const [i, index] of [1, 3].entries()) {
    assert.equal(isPrivateFrameData(resolved[index].data), false);
    const decoded = decodeFunctionData({ abi: quantumWalletAbi, data: resolved[index].data });
    assert.equal(decoded.functionName, 'execute');
    assert.equal(decoded.args[1], 10n + BigInt(i));
  }
  assert.equal(toFrames(resolved, frameBudgets).length, 4);
  assert.equal(isPrivateFrameData(action.frames[1].data), true, 'original plan remains immutable');
});

test('materialization rejects changed frame plan, missing proofs, duplicate nonces and wrong frame modes', async () => {
  const action = await composed('frame:tx (\n privacy:shield A "1"\n privacy:shield B "1"\n)');
  const result = proofResults(action), wallet = { address: sender, networkDomain: `0x${'01'.repeat(32)}` as const };
  assert.throws(() => materializePrivateFrames({ ...action, mempool: 'canonical' }, wallet, result), /frame plan/);
  assert.throws(() => materializePrivateFrames(action, wallet, { ...result, batches: [] }), /frame plan/);
  const duplicate = structuredClone(result); duplicate.batches![1].authorization!.nonce = 10n;
  assert.throws(() => materializePrivateFrames(action, wallet, duplicate), /nonces/);
  const changed = structuredClone(action); changed.frames[1].gas = 1n;
  assert.throws(() => materializePrivateFrames(changed, wallet, result), /frame plan/);
  const invalid = structuredClone(action); invalid.frames[1].mode = 'verify';
  assert.throws(() => privateFrameRequests(invalid), /SENDER/);
});

test('runtime refuses canonical/private-account/wrong-sender frame plans before passkey access', async () => {
  const action = await composed('frame:tx (\n privacy:shield A "1"\n)');
  const runtime = new PrivateScriptRuntime(() => {}, () => {});
  const signer = { address: sender, sign: async () => { throw new Error('Must not sign'); } };
  const ctx = { onLog: () => {} } as ActionHandlerCtx;
  await assert.rejects(() => runtime.frameHandler('public', signer)(action, ctx), /Framecraft/);
  await assert.rejects(() => runtime.frameHandler('devnet', signer)({ ...action, mempool: 'canonical' }, ctx), /alt mempool/);
  await assert.rejects(() => runtime.frameHandler('devnet', signer)({ ...action, from: '0x2222222222222222222222222222222222222222' }, ctx), /test account/);
});

for (const outcome of ['success', 'recovered', 'reverted', 'rejected', 'unknown']) test(`frame runtime records ${outcome} and releases settled submissions`, async () => {
  const action = await composed(`frame:tx (
    privacy:transfer A "1" taker
    exec 0x3333333333333333333333333333333333333333 "claim()"
    privacy:swap "0.1" --expect "0.05"
  )`);
  const realSigner = privateKeyToFrameSigner(`0x${'0'.repeat(63)}1`);
  action.from = realSigner.address;
  const result = proofResults(action);
  const storage = new Map<string, string>();
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
  } });
  let prepares = 0, signatures = 0, sends = 0, expectedHash: `0x${string}`;
  const runtime = new PrivateScriptRuntime(() => {}, () => {});
  runtime.state.wallet = { address: sender, networkDomain: `0x${'01'.repeat(32)}` } as PrivateScriptWallet;
  // Replace external boundaries only: the actual frame codec, signature and RPC submission run below.
  Object.assign(runtime, {
    checkDeployment: async () => {},
    session: { execute: async (_wallet: unknown, request: { frameContext: string; requests: unknown[] }) => {
      prepares++; assert.equal(request.frameContext, privateFrameContext(action)); assert.equal(request.requests.length, 2); return result;
    }, refresh: async () => result.snapshot },
  });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://psi-essential-rebate-wrist.trycloudflare.com/rpc');
    const request = JSON.parse(String(init?.body));
    let value: unknown;
    if (request.method === 'eth_call') value = `0x${'0'.repeat(63)}1`;
    else if (request.method === 'eth_chainId') value = '0x539';
    else if (request.method === 'eth_getTransactionCount') value = '0x7';
    else if (request.method === 'eth_sendFrameTransaction') {
      sends++;
      assert.equal(storage.size, 1, 'journal exists before broadcast');
      const wire = request.params[0];
      assert.equal(wire.chainId, '0x539'); assert.equal(wire.nonceSeq, '0x7');
      assert.equal(wire.frames.length, 4);
      assert.ok(wire.frames.every((f: { data: string }) => !isPrivateFrameData(f.data)));
      assert.equal(decodeFunctionData({ abi: quantumWalletAbi, data: wire.frames[1].data }).functionName, 'execute');
      assert.equal(decodeFunctionData({ abi: quantumWalletAbi, data: wire.frames[3].data }).functionName, 'execute');
      if (outcome === 'unknown' || outcome === 'rejected' || outcome === 'recovered') return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Submission failed' } });
      value = expectedHash;
    } else if (request.method === 'eth_getTransactionReceipt') value = outcome === 'unknown' || outcome === 'rejected' ? null : {
      transactionHash: expectedHash, blockHash: `0x${'ab'.repeat(32)}`, blockNumber: '0x10', status: outcome === 'reverted' ? '0x0' : '0x1', frameReceipts: Array.from({ length: 4 }, (_, index) => ({ status: outcome === 'reverted' && index === 3 ? '0x0' : '0x1' })),
    };
    else if (request.method === 'skandha_explorer_getTransaction') value = { hash: expectedHash, admission: outcome === 'rejected'
      ? { txHash: expectedHash, outcome: 'rejected', checks: [{ rule: 'gas-limit', verdict: 'fail' }] } : null };
    else throw new Error(`Unexpected RPC: ${request.method}`);
    return Response.json({ jsonrpc: '2.0', id: request.id, result: value });
  };
  const signer: FrameSigner = { address: realSigner.address, sign: async input => {
    signatures++; const signed = await realSigner.sign(input); expectedHash = txHash(input.profile, signed); return signed;
  } };
  try {
    const submit = () => runtime.frameHandler('devnet', signer)(action, { onLog: () => {} } as ActionHandlerCtx);
    if (outcome === 'success' || outcome === 'recovered') await submit(); else await assert.rejects(submit);
    assert.equal(prepares, 1); assert.equal(signatures, 1); assert.equal(sends, 1);
    assert.equal(storage.size, outcome === 'unknown' ? 1 : 0);
    assert.equal(!!runtime.state.pending, outcome === 'unknown');
    if (outcome === 'rejected' || outcome === 'reverted') {
      await assert.rejects(submit, outcome === 'rejected' ? /rejected.*gas-limit/i : /reverted/i);
      assert.equal(sends, 2, 'a settled failure must not prevent the next submission');
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else delete globalThis.localStorage;
  }
});

for (const outcome of ['rejected', 'accepted', 'dropped', 'replaced', 'missing', 'unavailable']) test(`inspection reconciles a saved ${outcome} admission without a receipt`, async () => {
  const hash = '0x03802b447628601d7f30cf189e1e2911a591fa781d32ddc0af4fb9f7d49f06ad';
  const pending = { hash, frameCount: 5 } as const;
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let removed = false;
  const updates: Array<{ hash: string; error?: string; outcome?: string }> = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { removeItem: () => { removed = true; } } });
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    let result: unknown;
    if (request.method === 'eth_chainId') result = '0x539';
    else if (request.method === 'eth_getTransactionReceipt') result = null;
    else if (request.method === 'skandha_explorer_getTransaction') {
      if (outcome === 'unavailable') throw new Error('Explorer unavailable');
      result = { hash, admission: outcome === 'missing' ? null : { txHash: hash, outcome, checks: [{ rule: 'gas-limit', verdict: 'fail' }] } };
    } else throw new Error(`Unexpected RPC: ${request.method}`);
    return Response.json({jsonrpc:'2.0',id:request.id,result});
  };
  try {
    const runtime = new PrivateScriptRuntime(() => {}, update => updates.push(update));
    runtime.state.pending = pending;
    await assert.rejects(() => runtime.inspect(), outcome === 'rejected' ? /rejected.*gas-limit/i : /pending|unknown/i);
    assert.equal(removed, outcome === 'rejected');
    assert.equal(!!runtime.state.pending, outcome !== 'rejected');
    if (outcome === 'rejected') assert.equal(updates.at(-1)?.outcome, 'rejected');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else delete globalThis.localStorage;
  }
});

test('failure to prepare any private proof prevents all frame submission', async () => {
  const action = await composed('frame:tx (\n privacy:transfer A "1" taker\n privacy:swap "0.1" --expect "0.05"\n)');
  const runtime = new PrivateScriptRuntime(() => {}, () => {});
  runtime.state.wallet = { address: sender } as PrivateScriptWallet;
  let sent = false;
  Object.assign(runtime, { session: { execute: async () => { throw new Error('distinct confirmed input required'); } }, sendFrames: async () => { sent = true; } });
  await assert.rejects(() => runtime.frameHandler('devnet', { address: sender } as FrameSigner)(action, { onLog: () => {} } as ActionHandlerCtx), /distinct confirmed/);
  assert.equal(sent, false);
});

test('native @token(address) works in private commands without replacing the standard helper', async () => {
  const actions = await interpret(`privacy:shield @token("${privateTokens.A}") "1"`);
  assert.equal(actions[0].params[0].token, 'A');
});

test('imported @token resolves local symbols for private and public calls inside frame:tx', async () => {
  const actions = await evml.script(`load frame
load privacy [@token]
set $asset @token("FPA")
frame:tx (
  privacy:transfer $asset "1" taker
  privacy:unshield @token("FPB") "0.5" @me
  exec @token("FPA") "claim()"
)`).interpret();
  const action = actions[0] as FrameAction;
  const requests = privateFrameRequests(action);
  assert.deepEqual(requests.map(r => r.token), ['A', 'B']);
  assert.equal(requests[1].recipient, sender, '@me retains its public relay meaning');
  assert.equal(action.frames.at(-1)!.target?.toLowerCase(), privateTokens.A.toLowerCase());
});

test('qualified private token helper, direct symbols and configured addresses all normalize to the same assets', async () => {
  const actions = await interpret(`privacy:shield FPA "1"
privacy:shield FPB "1"
privacy:shield @privacy:token("FPA") "1"
privacy:shield "${privateTokens.B.toUpperCase().replace('0X', '0x')}" "1"`);
  assert.deepEqual(actions.map(a => a.params[0].token), ['A', 'B', 'A', 'B']);
});

test('helpers cannot reinterpret public addresses as private recipients/pockets or introduce unsupported assets', async () => {
  await assert.rejects(() => interpret('privacy:transfer FPA "1" @me'), /unshield/);
  await assert.rejects(() => interpret('privacy:shield FPA "1" --wallet @me'), /private pocket/);
  await assert.rejects(() => interpret(`privacy:shield @token("${sender}") "1"`), /Other tokens/);
  await assert.rejects(() => evml.script('load privacy [@token]\nprivacy:shield @token("USDC") "1"').interpret(), /Other tokens/);
});

test('a frame can route private transfers among more than two dynamically named owned pockets', async () => {
  const action = await composed(`frame:tx (
    batch (
      privacy:transfer FPA "1" savings --wallet payroll
      privacy:transfer FPA "2" trading --wallet treasury
      privacy:transfer FPA "3" reserves --wallet operations
    )
  )`);
  const requests = privateFrameRequests(action);
  assert.deepEqual(requests.map(r => [r.wallet, r.receiver]), [['payroll', 'savings'], ['treasury', 'trading'], ['operations', 'reserves']]);
  const names = collectPrivatePockets({ action: 'frame-batch', requests, frameContext: privateFrameContext(action) });
  for (const name of ['payroll', 'savings', 'treasury', 'trading', 'operations', 'reserves']) assert.ok(names.includes(name));
  assert.deepEqual(requests.map(validatePrivateIntent), requests);
});

test('friends are variable-bound external private addresses, never locally derived identities', async () => {
  const friends = ['a', 'b', 'c'].map(letter => `0zk${letter.repeat(80)}`);
  const action = await composed(`set $alice "${friends[0]}"
set $bob "${friends[1]}"
set $charlie "${friends[2]}"
frame:tx (
  batch (
    privacy:transfer FPA "1" $alice --wallet savings
    privacy:transfer FPA "1" $bob --wallet savings
    privacy:transfer FPA "1" $charlie --wallet savings
  )
)`);
  const requests = privateFrameRequests(action);
  assert.deepEqual(requests.map(r => r.privateRecipient), friends);
  assert.deepEqual(collectPrivatePockets({ action: 'frame-batch', requests, frameContext: privateFrameContext(action) }), ['maker', 'taker', 'inventory', 'savings']);
});

test('custom liquidity pocket survives interpretation and handler revalidation for every inventory command', async () => {
  const actions = await interpret(`privacy:scan --wallets "savings,trading,liquidity"
privacy:add-inventory FPA "2" --wallet savings --inventory liquidity
privacy:remove-inventory FPA "1" --wallet savings --inventory liquidity
privacy:quote "0.1" --inventory liquidity
privacy:swap "0.1" --wallet trading --inventory liquidity --expect "0.2"`);
  const requests = actions.map(action => action.params[0]);
  assert.deepEqual(requests[0].pockets, ['savings', 'trading', 'liquidity']);
  assert.deepEqual([requests[1].wallet, requests[1].receiver], ['savings', 'liquidity']);
  assert.deepEqual([requests[2].wallet, requests[2].receiver], ['liquidity', 'savings']);
  assert.equal(requests[3].inventory, 'liquidity');
  assert.equal(requests[4].inventory, 'liquidity');
  assert.deepEqual(requests.map(validatePrivateIntent), requests);
  for (const command of [
    'swap "1" --expect "1" --wallet liquidity --inventory liquidity',
    'add-inventory FPA "1" --wallet liquidity --inventory liquidity',
    `swap "1" --expect "1" --inventory "0zk${'a'.repeat(80)}"`,
    'scan --wallets "savings,constructor"',
  ]) await assert.rejects(() => interpret(`privacy:${command}`));
});

test('quotes use the selected liquidity pocket and refuse unscanned ones', async () => {
  const runtime = new PrivateScriptRuntime(() => {}, () => {});
  Object.assign(runtime, { session: { refresh: async () => ({
    balances: { liquidity: { A: '10', B: '5' }, inventory: { A: '999', B: '999' } },
    spendable: { liquidity: { A: '10', B: '5' } },
  }) } });
  const logs: string[] = [];
  const ctx = { onLog: (message: string) => logs.push(message) } as ActionHandlerCtx;
  const handler = runtime.handler('devnet', { address: sender } as FrameSigner);
  await handler({ type: 'wallet', method: PRIVATE_METHOD, params: [{ action: 'quote', amount: '5', inventory: 'liquidity' }] }, ctx);
  assert.match(logs[0], /5 FPB → 5 FPA/);
  assert.match(logs[0], /--inventory liquidity --expect "5"/);
  await assert.rejects(() => handler({ type: 'wallet', method: PRIVATE_METHOD, params: [{ action: 'quote', amount: '5', inventory: 'unscanned' }] }, ctx), /scan --wallet unscanned/);
});

test('scanning a new pocket requires derivation and retains its name for recovery and later scans', async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem: (key: string, value: string) => saved.set(key, value) } });
  try {
    const runtime = new PrivateScriptRuntime(() => {}, () => {});
    runtime.state.wallet = { address: sender } as PrivateScriptWallet;
    runtime.state.snapshot = { addresses: { maker: 'legacy' } } as BrowserPrivateSnapshot;
    let derives = 0, refreshes = 0;
    let snapshot: BrowserPrivateSnapshot;
    Object.assign(runtime, { session: { active: true,
      execute: async (_wallet: unknown, intent: { pockets: string[] }) => {
        derives++;
        snapshot = { owner: sender, root: '0x00', addresses: Object.fromEntries(intent.pockets.map(name => [name, `0zk-${name}`])),
          balances: Object.fromEntries(intent.pockets.map(name => [name, { A: '0', B: '0' }])),
          spendable: Object.fromEntries(intent.pockets.map(name => [name, { A: '0', B: '0' }])) };
        return { snapshot, calls: [] };
      },
      refresh: async () => { refreshes++; return snapshot; },
    } });
    const handler = runtime.handler('devnet', { address: sender } as FrameSigner), ctx = { onLog: () => {} } as ActionHandlerCtx;
    const scan = (wallet: string) => ({ type: 'wallet' as const, method: PRIVATE_METHOD, params: [{ action: 'scan', wallet }] });
    await handler(scan('savings'), ctx);
    assert.equal(derives, 1); assert.equal(refreshes, 0);
    assert.ok(runtime.state.wallet!.pockets!.includes('savings'));
    assert.ok(JSON.parse([...saved.values()][0]).pockets.includes('savings'));
    await handler(scan('maker'), ctx);
    assert.equal(derives, 1); assert.equal(refreshes, 1);
    assert.ok(runtime.state.snapshot!.addresses.savings);
    // Re-selecting already known names must not consume the pocket limit twice.
    const full = ['maker', 'taker', 'inventory', ...Array.from({ length: 61 }, (_, i) => `pocket${i}`)];
    runtime.state.wallet!.pockets = full;
    await handler({ type: 'wallet', method: PRIVATE_METHOD, params: [{ action: 'scan', wallet: 'maker', pockets: full }] }, ctx);
    assert.equal(derives, 2);
    assert.equal(Object.keys(runtime.state.snapshot!.addresses).length, 64);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else delete globalThis.localStorage;
  }
});

test('wallet deployment status comes from live code and gateway failures remain unknown', async () => {
  const originalFetch = globalThis.fetch;
  const runtime = new PrivateScriptRuntime(() => {}, () => {});
  runtime.state.wallet = { address: sender } as PrivateScriptWallet;
  Object.assign(runtime, { checkDeployment: async () => {} });
  try {
    for (const code of ['0x6000', '0x']) {
      globalThis.fetch = async (_, init) => {
        const request = JSON.parse(String(init?.body));
        assert.equal(request.method, 'eth_getCode');
        assert.deepEqual(request.params, [sender, 'latest']);
        return Response.json({ jsonrpc: '2.0', id: request.id, result: code });
      };
      await runtime.refreshWalletDeployment();
      assert.equal(runtime.state.deploymentStatus, code === '0x' ? 'undeployed' : 'deployed');
    }
    globalThis.fetch = async () => { throw new Error('Gateway unavailable'); };
    await runtime.refreshWalletDeployment();
    assert.equal(runtime.state.deploymentStatus, 'unknown');
    assert.match(runtime.state.deploymentError!, /Could not check/);
  } finally { globalThis.fetch = originalFetch; }
});

test('a faucet cooldown blocks repeat claims before signing or submission', async () => {
  const originalFetch = globalThis.fetch;
  const runtime = new PrivateScriptRuntime(() => {}, () => {});
  runtime.state.wallet = { address: sender } as PrivateScriptWallet;
  let signed = false;
  globalThis.fetch = async (_, init) => {
    const request = JSON.parse(String(init?.body));
    assert.ok(['eth_call', 'eth_getBlockByNumber'].includes(request.method));
    return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_call'
      ? `0x${(1794102167n).toString(16).padStart(64, '0')}` : { timestamp: '0x6aee823c' } });
  };
  try {
    await assert.rejects(() => runtime.faucet({ address: sender, sign: async () => { signed = true; throw new Error('Must not sign'); } }, new AbortController().signal, () => {}), /already received.*Next claim/);
    assert.equal(signed, false);
    assert.equal(runtime.state.pending, undefined);
  } finally { globalThis.fetch = originalFetch; }
});
