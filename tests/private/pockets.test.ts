import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { collectPrivatePockets, legacyPockets, MAX_PRIVATE_POCKETS, pocketName, privateParticipants, privatePocketEntropy } from '../../scripts/private/browser/pockets.ts';
import type { BrowserPrivateRequest } from '../../scripts/private/browser/types.ts';

test('dynamic pocket derivation preserves every legacy seed and keeps new names deterministic and distinct', async () => {
  const source = new Uint8Array(32).fill(42);
  const key = await crypto.subtle.importKey('raw', source, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived: string[] = [];
  for (const name of [...legacyPockets, 'savings', 'trading', 'liquidity', 'friend-funds']) {
    const entropy = await privatePocketEntropy(key, name);
    const expected = createHmac('sha256', source).update(`FramePay.PrivatePocket.v1:${name}`).digest();
    assert.deepEqual(Buffer.from(entropy), expected);
    assert.deepEqual(await privatePocketEntropy(key, name), entropy);
    derived.push(Buffer.from(entropy).toString('hex'));
    entropy.fill(0);
  }
  assert.equal(new Set(derived).size, derived.length);
});

test('party roles select dynamic owned pockets while external recipient addresses never become derivation labels', () => {
  const request: BrowserPrivateRequest = { action: 'swap', wallet: 'trading', receiver: 'savings', inventory: 'liquidity', token: 'B' };
  assert.deepEqual(privateParticipants(request), { wallet: 'trading', receiver: 'savings', inventory: 'liquidity' });
  assert.deepEqual(collectPrivatePockets(request), [...legacyPockets, 'trading', 'savings', 'liquidity']);
  assert.throws(() => privateParticipants({ ...request, wallet: 'liquidity' }), /differ/);
  const recipient = `0zk${'a'.repeat(80)}`;
  assert.ok(!collectPrivatePockets({ ...request, action: 'transfer', privateRecipient: recipient }).includes(recipient));
  for (const value of ['__proto__', 'constructor', 'prototype', 'Savings', '', '0x' + 'a'.repeat(40), recipient, 'a'.repeat(33), 1])
    assert.throws(() => pocketName(value));
});

test('bound pocket derivation work and retain known names supplied with the approved intent', () => {
  const request: BrowserPrivateRequest = { action: 'scan', wallet: 'maker', receiver: 'taker', token: 'A', pockets: ['savings', 'retirement', 'savings'] };
  assert.deepEqual(collectPrivatePockets(request), [...legacyPockets, 'savings', 'retirement']);
  assert.throws(() => collectPrivatePockets({ ...request, pockets: Array.from({ length: MAX_PRIVATE_POCKETS }, (_, i) => `pocket${i}`) }), /at most/);
});
