import type { OwnedNote } from './domain.js';
import { check } from './errors.js';
import { bytesToHex } from 'viem';

/** A transaction may spend each confirmed note only once. Newly created notes are not selectable. */
export class PrivateNoteReservations {
  private readonly spent = new Set<string>();
  constructor(private readonly wallets: readonly { notes: OwnedNote[] }[]) {}
  consume(nullifiers: readonly (string | Uint8Array)[]): void {
    const normalized = nullifiers.map(value => {
      const n = typeof value === 'string' ? value : bytesToHex(value);
      const hex = `0x${n.replace(/^0x/, '').padStart(64, '0')}`.toLowerCase();
      check(/^0x[0-9a-f]{64}$/.test(hex), 'Invalid private nullifier');
      return hex;
    });
    check(new Set(normalized).size === normalized.length && normalized.every(n => !this.spent.has(n)), 'Private frame block spends an input note twice');
    check(normalized.every(n => this.wallets.some(w => w.notes.some(note => note.nullifier.toLowerCase() === n))), 'Private frame input is not a confirmed owned note');
    normalized.forEach(n => this.spent.add(n));
    for (const wallet of this.wallets) wallet.notes = wallet.notes.filter(note => !this.spent.has(note.nullifier.toLowerCase()));
  }
}
