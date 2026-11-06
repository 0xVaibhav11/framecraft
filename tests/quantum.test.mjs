import test from 'node:test';
import assert from 'node:assert/strict';
import { quantumChallenge, passkeyChallenge, validateFalconKey, falconKeyHash, quantumFactoryArgs, FALCON_PRF_SALT } from '../packages/sdk/dist/index.js';
import { keccak256, stringToHex } from 'viem';
const word = '0x' + '0001'.repeat(16), key = Array(32).fill(word);
test('Falcon keys require 512 canonical, nonzero field coefficients', () => {
  validateFalconKey(key);
  for (const bad of [[], key.slice(1), Array(32).fill('0x'+'00'.repeat(32)), ['0x'+'ffff'.repeat(16), ...key.slice(1)], Array(32).fill('0x01')]) assert.throws(() => validateFalconKey(bad));
});
test('quantum challenge binds batch/domain and cannot reuse a P256-only challenge', () => {
  const a = { chainId:1337n, wallet:'0x'+'11'.repeat(20), networkDomain:'0x'+'22'.repeat(32), nonce:0n, deadline:100n, calls:[{target:'0x'+'33'.repeat(20),value:1n,data:'0x'}] };
  const digest=quantumChallenge(a);
  assert.notEqual(digest,passkeyChallenge(a));
  for(const changed of [{nonce:1n},{deadline:101n},{chainId:1n},{wallet:'0x'+'44'.repeat(20)},{networkDomain:'0x'+'55'.repeat(32)},{calls:[{...a.calls[0],value:2n}]}]) assert.notEqual(digest,quantumChallenge({...a,...changed}));
  assert.equal(FALCON_PRF_SALT,keccak256(stringToHex('FramePay.ETHFALCON.v1')));
});
test('factory binds the Falcon public key and keeps seed out of public arguments', () => {
  const credential={qx:'0x'+'01'.repeat(32),qy:'0x'+'02'.repeat(32),credentialId:'AQID',rpId:'localhost',origin:'http://localhost:3000',falconPublicKey:key};
  const args=quantumFactoryArgs(credential,'0x'+'03'.repeat(32));
  assert.equal(args.length,3); assert.deepEqual(args[2],key.map(BigInt));
  assert.notEqual(falconKeyHash(key),falconKeyHash(['0x'+'0002'.repeat(16),...key.slice(1)]));
});
