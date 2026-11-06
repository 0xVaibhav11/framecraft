import { Context, Effect, Layer } from 'effect';
import { Prover, type TransactNote, type Proof } from '@railgun-community/engine';
import { groth16 } from 'snarkjs';
import { Transaction } from './engine.js';
import { VERSION } from './wallet.js';
import { CHAIN, ZERO, ZERO32, type CircuitArtifacts, type PrivateWallet, type OwnedNote, type ProofOptions, type ProvedPayment } from './domain.js';
import { attempt, check, type PrivacyError } from './errors.js';

export function createProver(artifacts: CircuitArtifacts): Prover {
  const prover = new Prover({
    getArtifactsPOI: async () => { throw new Error('POI artifacts are not configured'); },
    assertArtifactExists: (inputs, outputs) => check(inputs === 1 && outputs === 2, 'Only the 1-input/2-output circuit is installed'),
    getArtifacts: async ({ nullifiers, commitmentsOut }) => {
      check(nullifiers.length === 1 && commitmentsOut.length === 2, 'Unsupported circuit shape');
      return artifacts;
    },
  });
  prover.setSnarkJSGroth16({
    fullProve: (input, wasm, zkey) => groth16.fullProve(input, Uint8Array.from(wasm!), Uint8Array.from(zkey), undefined, undefined, { singleThread: true }),
    verify: (vkey: object, signals: bigint[], proof: Proof) => groth16.verify(vkey, signals, proof),
  });
  return prover;
}
export interface ProofService {
  prove(wallet: PrivateWallet, input: OwnedNote, notes: TransactNote[], options?: ProofOptions): Effect.Effect<ProvedPayment, PrivacyError>;
}
export class PrivateProver extends Context.Service<PrivateProver, ProofService>()('@framepay/privacy/Prover') {}
export const makeProofService = (prover: Prover): ProofService => ({
  prove: (wallet, input, notes, options = {}) => attempt('generate private proof', async () => {
    const { adapter = ZERO, params = ZERO32, unshield } = options;
    const tx = new Transaction(CHAIN, input.note.tokenData, 0, [input], notes, { contract: adapter, parameters: params });
    if (unshield) tx.addUnshieldData({ tokenData: input.note.tokenData, toAddress: unshield.to, allowOverride: false }, unshield.amount);
    const request = await tx.generateTransactionRequest(wallet, VERSION, 'local-wallet-facade',
      { minGasPrice: 0n, chainID: 1337n, senderCiphertext: '0x', to: ZERO, data: '0x' });
    const started = performance.now();
    const signature = wallet.sign(request.publicInputs);
    const transaction = await tx.generateProvedTransaction(VERSION, prover,
      { ...request, signature: [...signature.R8, signature.S] }, () => {});
    return { transaction, proofMs: Math.round(performance.now() - started) };
  }),
});
export const PrivateProverLive = (artifacts: CircuitArtifacts) => Layer.succeed(PrivateProver, makeProofService(createProver(artifacts)));

/** snarkjs caches curve workers globally, including after a failed proof. */
export async function closeProverWorkers(): Promise<void> {
  const curves = globalThis as typeof globalThis & {
    curve_bn128?: { terminate(): Promise<void> }; curve_bls12381?: { terminate(): Promise<void> };
  };
  await curves.curve_bn128?.terminate();
  await curves.curve_bls12381?.terminate();
}
