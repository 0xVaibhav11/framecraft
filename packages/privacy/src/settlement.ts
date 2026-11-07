import { Effect } from 'effect';
import { Interface } from 'ethers';
import { encodeAbiParameters, keccak256, stringToHex, isAddress, type Address, type Hex } from 'viem';
import type { PrivateWallet, Quote } from './domain.js';
import { hex32 } from './domain.js';
import { check, PrivacyError } from './errors.js';
import { railgunInterface } from './abi.js';
import { PrivateProver } from './prover.js';
import { select, outputs } from './wallet.js';

export const SWAP_DOMAIN = keccak256(stringToHex('FramePay.PrivateSwap.v1'));
export const privateSwapInterface = new Interface([
  `function privateSwap(${railgunInterface.getFunction('transact')!.inputs[0].format('full')}, bytes32 tradeId, uint64 deadline, bytes32 payment0, bytes32 payment1)`,
  'function conditions(bytes32 tradeId, uint64 deadline, bytes32 payment0, bytes32 payment1) view returns (bytes32)',
]);
export { quoteExactIn } from './quote.js';
export function swapConditions(chainId: bigint, adapter: Address, pool: Address, quote: Quote): Hex {
  check(chainId > 0n && isAddress(adapter) && isAddress(pool), 'Invalid settlement domain');
  check(quote.deadline > 0n && quote.deadline < 1n << 64n, 'Deadline must fit uint64');
  check([quote.tradeId, quote.payment0, quote.payment1].every((v) => /^0x[\da-fA-F]{64}$/.test(v)), 'Expected bytes32 quote fields');
  check(quote.payment0.toLowerCase() !== quote.payment1.toLowerCase(), 'Payments must be distinct');
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [SWAP_DOMAIN, chainId, adapter, pool, quote.tradeId, quote.deadline, quote.payment0, quote.payment1],
  ));
}
export interface SwapRequest {
  readonly maker: PrivateWallet;
  readonly taker: PrivateWallet;
  readonly makerToken: Address;
  readonly takerToken: Address;
  readonly makerAmount: bigint;
  readonly takerAmount: bigint;
  readonly pool: Address;
  readonly adapter: Address;
  readonly tradeId: Hex;
  readonly deadline: bigint;
}
/** Prepare both parties' exact consent. Proofs are never silently repriced or resubmitted. */
export const preparePrivateSwap = (request: SwapRequest) => Effect.gen(function* () {
  const prover = yield* PrivateProver;
  const plan = yield* Effect.try({
    try: () => {
      check(request.makerToken.toLowerCase() !== request.takerToken.toLowerCase(), 'Swap assets must differ');
      const makerInput = select(request.maker, request.makerToken, request.makerAmount);
      const takerInput = select(request.taker, request.takerToken, request.takerAmount);
      const makerOutputs = outputs(request.maker, request.taker, makerInput, request.makerAmount);
      const takerOutputs = outputs(request.taker, request.maker, takerInput, request.takerAmount);
      const quote: Quote = { tradeId: request.tradeId, deadline: request.deadline, payment0: hex32(makerOutputs[0].hash), payment1: hex32(takerOutputs[0].hash) };
      return { makerInput, takerInput, makerOutputs, takerOutputs, quote, params: swapConditions(1337n, request.adapter, request.pool, quote) };
    },
    catch: (error) => error instanceof PrivacyError ? error : new PrivacyError({ operation: 'quote', message: 'Invalid swap request' }),
  });
  const options = { adapter: request.adapter, params: plan.params };
  // Each party signs its own note spend. Sequential proving bounds local memory use.
  const maker = yield* prover.prove(request.maker, plan.makerInput, plan.makerOutputs, options);
  const taker = yield* prover.prove(request.taker, plan.takerInput, plan.takerOutputs, options);
  const legs = [maker.transaction, taker.transaction];
  const { tradeId, deadline, payment0, payment1 } = plan.quote;
  const calldata = yield* Effect.try({
    try: () => privateSwapInterface.encodeFunctionData('privateSwap', [legs, tradeId, deadline, payment0, payment1]) as Hex,
    catch: () => new PrivacyError({ operation: 'encode swap', message: 'Invalid proved settlement data' }),
  });
  return { quote: plan.quote, params: plan.params, legs, inputs: [plan.makerInput, plan.takerInput],
    proofGenerationMs: [maker.proofMs, taker.proofMs], calldata };
});
