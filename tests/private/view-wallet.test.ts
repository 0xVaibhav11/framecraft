import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWallet, type MerkleView } from '@framepay/privacy';
import { makeViewWallet } from '../../packages/privacy/src/view-wallet.ts';

test('view-only wallet copies no spending authority and can be independently cleared', async()=>{
  const tree:MerkleView={getRoot:()=>`0x${'00'.repeat(32)}`,getMerkleProof:()=>({elements:[]})};
  const source=await makeWallet('owner',tree);
  const view=makeViewWallet(source);
  for(const key of ['mnemonic','sign','getSpendingKeyPair','getViewingKeyPair','addressKeys'])assert.equal(key in view.wallet,false);
  assert.deepEqual(view.wallet.viewingKeyPair.privateKey,source.viewingKeyPair.privateKey);
  assert.notEqual(view.wallet.viewingKeyPair.privateKey,source.viewingKeyPair.privateKey);
  assert.equal(view.wallet.getNullifyingKey(),source.getNullifyingKey());
  const sourceKey=source.viewingKeyPair.privateKey.slice();
  view.dispose();
  assert.ok(view.wallet.viewingKeyPair.privateKey.every(byte=>byte===0));
  assert.equal(view.wallet.getNullifyingKey(),0n);
  assert.deepEqual(source.viewingKeyPair.privateKey,sourceKey);
});
