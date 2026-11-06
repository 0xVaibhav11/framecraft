/** Generates ephemeral test witnesses for Foundry FFI; never used by the application. */
import { randomBytes } from 'node:crypto';
import { Effect } from 'effect';
import { Merkletree, ShieldNote, ShieldNoteERC20, TransactNote, getTokenDataERC20 } from '@railgun-community/engine';
import { encodeAbiParameters, type Address, type Hex } from 'viem';
import { makeWallet, outputs, hex32, preparePrivateSwap, PrivateProverLive, makeProofService, createProver,
  railgunInterface, closeProverWorkers, type MerkleView } from '@framepay/privacy';
import { initPoseidonPromise, MERKLE_ZERO_VALUE } from '../dist/engine.js';
import { prepareArtifacts } from '../../../scripts/private/artifacts.ts';
import { readJson, root } from '../../../scripts/private/files.ts';
import { resolve } from 'node:path';

class WitnessTree implements MerkleView {
  readonly leaves: string[] = [];
  readonly zeros: string[] = [MERKLE_ZERO_VALUE];
  constructor() { for (let i = 0; i < 16; i++) this.zeros.push(Merkletree.hashLeftRight(this.zeros[i], this.zeros[i])); }
  layers(): string[][] {
    const layers = [this.leaves];
    for (let level = 0; level < 16; level++) {
      const next: string[] = [], row = layers[level];
      for (let i = 0; i < row.length; i += 2) next.push(Merkletree.hashLeftRight(row[i], row[i + 1] ?? this.zeros[level]));
      layers.push(next);
    }
    return layers;
  }
  getRoot(): string { return `0x${(this.layers()[16][0] ?? this.zeros[16]).replace(/^0x/, '')}`; }
  getMerkleProof(_tree: number, position: number) {
    const layers = this.layers(), elements: string[] = [];
    for (let i = 0; i < 16; i++) { elements.push(layers[i][position ^ 1] ?? this.zeros[i]); position >>= 1; }
    return { elements };
  }
}
try {
  if (process.argv[2] === 'verification-key') {
    const keys = await readJson<{ nullifiers: number; commitments: number; verifyingKey: unknown[] }[]>(resolve(root, 'config/private/railgun/railgun-verification-keys.json'));
    process.stdout.write(railgunInterface.encodeFunctionData('setVerificationKey', [1, 2, keys.find((key) => key.nullifiers === 1 && key.commitments === 2)!.verifyingKey]));
  } else {
    await initPoseidonPromise;
    const [A, B, adapter, pool] = process.argv.slice(2) as Address[];
    const tree = new WitnessTree();
    const maker = await makeWallet('test-maker', tree), taker = await makeWallet('test-taker', tree);
    const U = 10n ** 18n;
    const shieldNotes = [[maker, A], [taker, B]] as const;
    const requests = [];
    for (const [wallet, token] of shieldNotes) {
      const note = new ShieldNoteERC20(wallet.address.masterPublicKey, TransactNote.getNoteRandom(), 10_000n * U, token);
      requests.push(await note.serialize(randomBytes(32), wallet.viewingKeyPair.pubkey));
      const hash = ShieldNote.getShieldNoteHash(note.notePublicKey, token, 9975n * U);
      const position = tree.leaves.length;
      tree.leaves.push(hex32(hash));
      wallet.notes = [{ position, nullifier: hex32(TransactNote.getNullifier(wallet.getNullifyingKey(), position)),
        note: { random: note.random, value: 9975n * U, tokenData: getTokenDataERC20(token), hash } }];
    }
    const initialRoot = tree.getRoot() as Hex;
    const artifacts = await prepareArtifacts();
    const proofService = makeProofService(createProver(artifacts));
    const transferOutputs = outputs(maker, taker, maker.notes[0], 100n * U);
    const transfer = await Effect.runPromise(proofService.prove(maker, maker.notes[0], transferOutputs));
    const changePosition = tree.leaves.length + 1;
    tree.leaves.push(...transfer.transaction.commitments.map((value) => String(value)));
    maker.notes = [{ position: changePosition, nullifier: hex32(TransactNote.getNullifier(maker.getNullifyingKey(), changePosition)), note: transferOutputs[1] }];
    const afterTransferRoot = tree.getRoot() as Hex;
    const swap = await Effect.runPromise(preparePrivateSwap({ maker, taker, makerToken: A, takerToken: B, makerAmount: 200n * U,
      takerAmount: 500n * U, pool, adapter, tradeId: hex32(123), deadline: 1000n }).pipe(Effect.provide(PrivateProverLive(artifacts))));
    process.stdout.write(encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [railgunInterface.encodeFunctionData('shield', [requests]) as Hex,
        railgunInterface.encodeFunctionData('transact', [[transfer.transaction]]) as Hex,
        swap.calldata, initialRoot, afterTransferRoot]));
  }
} finally { await closeProverWorkers(); }
