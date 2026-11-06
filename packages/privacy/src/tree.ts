import { Merkletree, ShieldNote } from '@railgun-community/engine';
import type { Address, Hex } from 'viem';
import { railgunABI, railgunInterface } from './abi.js';
import { initPoseidonPromise, MERKLE_ZERO_VALUE } from './engine.js';
import { hex32 } from './domain.js';
import { check } from './errors.js';
import { readContract, type RpcClient } from './rpc.js';

interface ShieldCiphertext { shieldKey: string; encryptedBundle: [string, string, string] }
interface Ciphertext {
  ciphertext: [string, string, string, string];
  blindedSenderViewingKey: string;
  blindedReceiverViewingKey: string;
  annotationData: string;
  memo: string;
}
interface Preimage { npk: string; token: { tokenType: bigint; tokenAddress: string; tokenSubID: bigint }; value: bigint }
interface EventBase { position: number; hash: Hex; blockNumber: number }
export type NoteEvent = EventBase & (
  { kind: 'Shield'; preimage: Preimage; ciphertext: ShieldCiphertext } |
  { kind: 'Transact'; ciphertext: Ciphertext }
);
interface Log { topics: string[]; data: string; blockNumber: Hex; logIndex: Hex; removed?: boolean }

/** Single-tree, full-rescan devnet index. A failed sync never publishes a partial tree. */
export class PrivateTree {
  events: readonly NoteEvent[] = [];
  private layers: string[][] = [];
  private zeros: string[] = [];
  constructor(readonly rpc: RpcClient, readonly pool: Address, readonly startBlock: Hex) {}

  async sync(): Promise<void> {
    await initPoseidonPromise;
    const zeros = [MERKLE_ZERO_VALUE];
    for (let i = 1; i <= 16; i++) zeros.push(Merkletree.hashLeftRight(zeros[i - 1], zeros[i - 1]));
    const block = await this.rpc.request<Hex>('eth_blockNumber');
    const logs = await this.rpc.request<Log[]>('eth_getLogs', [{ address: this.pool, fromBlock: this.startBlock, toBlock: block }]);
    logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
    const leaves: string[] = [];
    const events: NoteEvent[] = [];
    for (const log of logs) {
      check(!log.removed, 'Removed log requires resynchronization');
      let parsed;
      try { parsed = railgunInterface.parseLog(log); } catch { continue; }
      if (!parsed || !['Shield', 'Transact'].includes(parsed.name)) continue;
      const args = parsed.args;
      check(args.treeNumber === 0n, 'Only one 65,536-note tree is supported');
      const preimages = args.commitments as readonly Preimage[] | undefined;
      const hashes: string[] = parsed.name === 'Shield'
        ? preimages!.map((c) => {
          check(c.token.tokenType === 0n, 'Only ERC-20 shield notes are supported');
          return hex32(ShieldNote.getShieldNoteHash(BigInt(c.npk), c.token.tokenAddress, c.value));
        }) : [...args.hash] as string[];
      for (let i = 0; i < hashes.length; i++) {
        const position = Number(args.startPosition) + i;
        check(position === leaves.length && position < 65_536, 'Missing, duplicate, or out-of-order commitments');
        const base = { position, hash: hashes[i] as Hex, blockNumber: Number(BigInt(log.blockNumber)) };
        leaves.push(hashes[i]);
        events.push(parsed.name === 'Shield'
          ? { ...base, kind: 'Shield', preimage: preimages![i], ciphertext: args.shieldCiphertext[i] as ShieldCiphertext }
          : { ...base, kind: 'Transact', ciphertext: args.ciphertext[i] as Ciphertext });
      }
    }
    const layers = [leaves];
    for (let level = 0; level < 16; level++) {
      const next: string[] = [];
      const row = layers[level];
      for (let i = 0; i < row.length; i += 2) next.push(Merkletree.hashLeftRight(row[i], row[i + 1] ?? zeros[level]));
      layers.push(next);
    }
    const root = hex32(`0x${(layers[16][0] ?? zeros[16]).replace(/^0x/, '')}`);
    // Read the root at the log snapshot block, not a newer tip.
    const result = await this.rpc.request<Hex>('eth_call', [{ to: this.pool, data: railgunInterface.encodeFunctionData('merkleRoot') }, block]);
    const actual = railgunInterface.decodeFunctionResult('merkleRoot', result)[0] as string;
    check(actual.toLowerCase() === root.toLowerCase(), 'Commitment index disagrees with the RAILGUN root');
    this.zeros = zeros;
    this.layers = layers;
    this.events = events;
  }

  getRoot(): string {
    check(this.zeros.length === 17, 'Synchronize the tree before reading it');
    return `0x${(this.layers[16][0] ?? this.zeros[16]).replace(/^0x/, '')}`;
  }
  getMerkleProof(tree: number, position: number): { elements: string[] } {
    check(tree === 0 && Number.isInteger(position) && position >= 0 && position < (this.layers[0]?.length ?? 0), 'Unknown note position');
    const elements: string[] = [];
    let index = position;
    for (let level = 0; level < 16; level++) {
      elements.push(this.layers[level][index ^ 1] ?? this.zeros[level]);
      index >>= 1;
    }
    return { elements };
  }
  isSpent(nullifier: Hex): Promise<boolean> {
    return readContract(this.rpc, this.pool, railgunABI, 'nullifiers', [0n, nullifier]);
  }
}
