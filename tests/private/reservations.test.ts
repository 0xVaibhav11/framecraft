import test from 'node:test';
import assert from 'node:assert/strict';
import { PrivateNoteReservations, select, hex32, type OwnedNote, type PrivateWallet } from '@framepay/privacy';

const token = '0x1111111111111111111111111111111111111111';
const note = (n: number): OwnedNote => ({ position: n, nullifier: hex32(n), note: { value: 10n, random: '', hash: BigInt(n), tokenData: { tokenAddress: token, tokenType: 0, tokenSubID: '0' } } });
test('frame preparation reserves whole inputs and chooses another confirmed note for the next spend', () => {
  const wallet = { notes: [note(1), note(2)] } as PrivateWallet;
  const reserves = new PrivateNoteReservations([wallet]);
  assert.equal(select(wallet, token, 1n).position, 1);
  reserves.consume([hex32(1)]);
  assert.equal(select(wallet, token, 1n).position, 2);
  reserves.consume([hex32(2)]);
  assert.throws(() => select(wallet, token, 1n), /single unspent note/);
  assert.throws(() => reserves.consume([hex32(1)]), /twice/);
});
test('duplicate and unknown nullifiers fail without partially reserving inputs', () => {
  const wallet = { notes: [note(1), note(2)] };
  const reserves = new PrivateNoteReservations([wallet]);
  assert.throws(() => reserves.consume([hex32(1), hex32(1)]), /twice/);
  assert.equal(wallet.notes.length, 2);
  assert.throws(() => reserves.consume([hex32(1), hex32(3)]), /confirmed owned note/);
  assert.equal(wallet.notes.length, 2);
});
test('both private swap legs are reserved and byte-array nullifiers normalize correctly', () => {
  const maker = { notes: [note(1)] }, taker = { notes: [note(2)] };
  const reserves = new PrivateNoteReservations([maker, taker]);
  reserves.consume([Uint8Array.from(Buffer.from(hex32(1).slice(2), 'hex')), hex32(2).slice(2)]);
  assert.equal(maker.notes.length, 0);
  assert.equal(taker.notes.length, 0);
});
