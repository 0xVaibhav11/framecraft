import { Effect } from 'effect';
import type { Address, Hex } from 'viem';
import type { PrivateWallet } from './domain.js';
import { PrivateProver } from './prover.js';
import { PrivateSubmitter } from './frames.js';
import { railgunInterface } from './abi.js';
import { select, outputs } from './wallet.js';
import { PrivacyError } from './errors.js';

/** Transfers also implement adding/removing maker inventory in a separate quoting wallet. */
export const preparePrivateTransfer = (sender: PrivateWallet, receiver: PrivateWallet, token: Address, amount: bigint) => Effect.gen(function* () {
  const prover = yield* PrivateProver;
  const payment = yield* Effect.try({
    try: () => { const input = select(sender, token, amount); return { input, notes: outputs(sender, receiver, input, amount) }; },
    catch: () => new PrivacyError({ operation: 'transfer', message: 'Invalid amount or insufficient single-note balance' }),
  });
  const proved = yield* prover.prove(sender, payment.input, payment.notes);
  const calldata = yield* Effect.try({
    try: () => railgunInterface.encodeFunctionData('transact', [[proved.transaction]]) as Hex,
    catch: () => new PrivacyError({ operation: 'encode transfer', message: 'Invalid proved payment data' }),
  });
  return { ...proved, calldata };
});
export const privateTransfer = (pool: Address, sender: PrivateWallet, receiver: PrivateWallet, token: Address, amount: bigint, label = 'private-transfer') => Effect.gen(function* () {
  const prepared = yield* preparePrivateTransfer(sender, receiver, token, amount);
  const submitter = yield* PrivateSubmitter;
  return yield* submitter.send(pool, prepared.calldata, label);
});
