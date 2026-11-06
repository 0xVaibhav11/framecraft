import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { bytesToHex, sha256, stringToHex } from 'viem';
import { passkeyChallenge, decodeP256Signature, parsePasskeyProof, passkeyFactoryArgs } from '../packages/sdk/dist/passkey.js';
const hash = `0x${'11'.repeat(32)}`;
const base = { chainId: 1337n, wallet: '0x0000000000000000000000000000000000000011', networkDomain: hash, nonce: 0n, deadline: 1000n,
  calls: [{ target: '0x0000000000000000000000000000000000000022', value: 0n, data: '0x1234' }] };
const bytes = buffer => Uint8Array.from(buffer).buffer;
const credential = { origin: 'http://localhost:3000', rpId: 'localhost' };
function response(overrides = {}, flags = 5) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(hash.slice(2), 'hex').toString('base64url'), origin: credential.origin, crossOrigin: false, ...overrides }));
  const authenticatorData = Buffer.concat([createHash('sha256').update('localhost').digest(), Buffer.from([flags, 0, 0, 0, 0])]);
  const payload = Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]);
  const signature = sign('sha256', payload, privateKey);
  return { response: { clientDataJSON: bytes(clientDataJSON), authenticatorData: bytes(authenticatorData), signature: bytes(signature) }, publicKey, payload };
}
test('passkey challenge binds calls, wallet, chain, genesis, nonce and expiry', () => {
  const expected = passkeyChallenge(base);
  for (const changed of [{ nonce: 1n }, { deadline: 1001n }, { chainId: 1n }, { networkDomain: `0x${'22'.repeat(32)}` }, { wallet: base.calls[0].target },
    { calls: [{ ...base.calls[0], value: 1n }] }, { calls: [{ ...base.calls[0], data: '0x1235' }] }, { calls: [{ ...base.calls[0], target: base.wallet }] }, { calls: [base.calls[0], base.calls[0]] }])
    assert.notEqual(passkeyChallenge({ ...base, ...changed }), expected);
});
test('WebAuthn parser preserves signed bytes and produces valid normalized P256 scalars', () => {
  const sample = response(); const proof = parsePasskeyProof(sample.response, credential, hash);
  assert.equal(proof.assertion.clientDataJSON, Buffer.from(sample.response.clientDataJSON).toString());
  const signature = Buffer.from(proof.assertion.r.slice(2) + proof.assertion.s.slice(2), 'hex');
  assert.equal(verify('sha256', sample.payload, { key: sample.publicKey, dsaEncoding: 'ieee-p1363' }, signature), true);
  assert.equal(proof.assertion.authenticatorData.slice(0,66), sha256(stringToHex('localhost')));
});
test('WebAuthn parser rejects wrong challenge, origin, type and cross-origin approval', () => {
  for (const change of [{ challenge: 'bad' }, { origin: 'https://evil.test' }, { type: 'webauthn.create' }, { crossOrigin: true }])
    assert.throws(() => parsePasskeyProof(response(change).response, credential, hash));
});
test('WebAuthn parser requires UV, presence and a matching relying party', () => {
  for (const flags of [0,1,4]) assert.throws(() => parsePasskeyProof(response({},flags).response, credential, hash));
  const sample = response().response;
  assert.throws(() => parsePasskeyProof(sample, { ...credential, rpId: 'evil.test' }, hash));
  assert.throws(() => parsePasskeyProof({ ...sample, authenticatorData: new ArrayBuffer(1) }, credential, hash));
});
test('DER parser rejects truncated, negative, nonminimal, zero and trailing scalars', () => {
  for (const data of ['','3006020101020100','3006020180020101','300702020001020101','3006020101020101ff','3006020101020201'])
    assert.throws(() => decodeP256Signature(Buffer.from(data, 'hex')));
  const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const highS = Buffer.from(`3026020101022100${(n-1n).toString(16)}`, 'hex');
  assert.equal(BigInt(decodeP256Signature(highS).s), 1n);
});
test('factory salt is bound to credential ID and rp/origin are hashed', () => {
  const input = { ...credential, credentialId: 'AQID', qx: hash, qy: hash };
  const args = passkeyFactoryArgs(input, hash);
  assert.equal(args[2], sha256(stringToHex('localhost')));
  assert.notEqual(args[5], passkeyFactoryArgs({ ...input, credentialId: 'AQIE' }, hash)[5]);
  assert.throws(() => passkeyFactoryArgs({ ...input, credentialId: '***' }, hash));
});
