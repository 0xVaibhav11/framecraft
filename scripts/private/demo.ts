import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Effect } from 'effect';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, stringToHex, type Address, type Hex } from 'viem';
import { toWire } from '@forshtat/hegota-support/rpc';
import { PrivateTree, makeWallet, scan, balance, select, outputs, shieldRequest, hex32,
  PrivateProver, PrivateProverLive, makeFrameTransport, preparePrivateTransfer, preparePrivateSwap, quoteExactIn,
  readContract, railgunABI, railgunInterface, privateSwapInterface, PrivacyError,
  type RpcClient, type CircuitArtifacts, type PrivateWallet, type FrameOptions, type FrameResult } from '@framepay/privacy';
import { runtime, local, saveJson, sourcePins } from './files.ts';
import type { Artifacts } from './build.ts';
import type { Infrastructure, Keys } from './deploy.ts';

export interface RunReport {
  runId: string; status: 'running' | 'passed' | 'failed'; chainId: number; infrastructure: Infrastructure;
  contractRuntimeBytes: number; swapvmRevision: string;
  flows: (FrameResult & { privateFlow: boolean; calldataBytes?: number })[];
  negativeChecks: { label: string; result: string }[];
  proofGenerationMs: { label: string; ms: number }[];
  balances?: Record<string, { A: string; B: string }>;
  unchangedCodeHashes?: { aqua: Hex; railgunProxy: Hex };
  error?: string;
  stage?: string;
  rpcUrl?: string;
}
export async function runDemo(rpc: RpcClient, artifacts: Artifacts, circuit: CircuitArtifacts, keys: Keys, infra: Infrastructure, rpcUrl?: string): Promise<RunReport> {
  const tree = new PrivateTree(rpc, infra.pool, infra.startBlock);
  await tree.sync();
  const wallets = await Promise.all(['maker', 'taker', 'maker-liquidity', 'outsider'].map((name) => makeWallet(name, tree)));
  const [maker, taker, lp, outsider] = wallets;
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  await saveJson(resolve(runtime, `wallets-${runId}.json`), wallets.map((wallet) => ({ label: wallet.label, mnemonic: wallet.mnemonic })));
  const report: RunReport = { runId, rpcUrl, status: 'running', chainId: 1337, infrastructure: infra,
    contractRuntimeBytes: artifacts.PrivateSwapVM.runtimeBytes, swapvmRevision: (await sourcePins()).swapvm.revision,
    flows: [], negativeChecks: [], proofGenerationMs: [] };
  const save = async () => {
    await saveJson(resolve(local, `reports/${runId}.json`), report);
    await saveJson(resolve(local, 'reports/latest.json'), report);
  };
  await save();
  const proverLayer = PrivateProverLive(circuit);
  const prove = (wallet: PrivateWallet, input: ReturnType<typeof select>, notes: ReturnType<typeof outputs>[number][], options = {}) =>
    Effect.runPromise(Effect.gen(function* () { return yield* (yield* PrivateProver).prove(wallet, input, notes, options); }).pipe(Effect.provide(proverLayer)));
  const publicTransport = makeFrameTransport(rpc, keys.deployer);
  const privateTransport = makeFrameTransport(rpc, keys.submitter);
  const A = infra.tokenA, B = infra.tokenB, U = 10n ** 18n;
  const transferTopic = keccak256(stringToHex('Transfer(address,address,uint256)'));
  const codeHash = async (address: Address) => keccak256(await rpc.request<Hex>('eth_getCode', [address, 'latest']));
  const aquaBefore = await codeHash(infra.aqua), poolBefore = await codeHash(infra.pool);
  const backing = () => Promise.all([A, B].map((token) => readContract<bigint>(rpc, token, artifacts.TestToken.abi, 'balanceOf', [infra.pool])));
  async function sync(): Promise<void> {
    await tree.sync();
    for (const wallet of wallets) await scan(wallet, tree);
    assert.equal(outsider.notes.length, 0, 'Unrelated wallet decrypted an owned note');
  }
  async function send(to: Address, data: Hex, label: string, options: FrameOptions & { privateFlow?: boolean } = {}): Promise<FrameResult> {
    const { privateFlow = true, ...frameOptions } = options;
    report.stage = label;
    const before = await backing();
    const result = await (privateFlow ? privateTransport : publicTransport).send(to, data, label, frameOptions);
    report.flows.push({ ...result, privateFlow, calldataBytes: (data.length - 2) / 2 });
    await save();
    if (privateFlow) {
      assert.ok(!result.receipt.logs.some((log) => log.topics[0] === transferTopic), 'Private flow emitted ERC-20 transfer');
      for (const token of [A, B]) assert.ok(!data.toLowerCase().includes(token.slice(2).toLowerCase()), 'Private calldata contains token address');
      assert.deepEqual(await backing(), before, 'Private flow changed pool backing');
    }
    console.log(`${label}: ${result.hash}`);
    await save();
    return result;
  }
  async function payment(sender: PrivateWallet, receiver: PrivateWallet, token: Address, amount: bigint, label: string) {
    const beforeSender = balance(sender, token), beforeReceiver = balance(receiver, token);
    const prepared = await Effect.runPromise(preparePrivateTransfer(sender, receiver, token, amount).pipe(Effect.provide(proverLayer)));
    report.proofGenerationMs.push({ label, ms: prepared.proofMs });
    await send(infra.pool, prepared.calldata, label);
    await sync();
    assert.equal(balance(sender, token), beforeSender - amount);
    assert.equal(balance(receiver, token), beforeReceiver + amount);
    return prepared.transaction;
  }
  async function expectCallFailure(label: string, to: Address, data: Hex): Promise<void> {
    let reverted = false;
    try { await rpc.request('eth_call', [{ from: privateKeyToAccount(keys.submitter).address, to, data, gas: '0x989680' }, 'latest']); }
    catch (error) {
      // Transport errors and malformed requests are not evidence that settlement reverted.
      if (!(error instanceof PrivacyError) || (error.rpcReason !== 'execution-reverted' && error.rpcCode !== 3)) throw error;
      reverted = true;
    }
    assert.ok(reverted, `${label} unexpectedly succeeded`);
    report.negativeChecks.push({ label, result: 'reverted' });
    await save();
  }
  try {
    const requests = await Promise.all([[maker, A], [maker, B], [taker, B]].map(([wallet, token]) => shieldRequest(wallet as PrivateWallet, token as Address, 10_000n * U)));
    await send(infra.pool, railgunInterface.encodeFunctionData('shield', [requests]) as Hex, 'public-shield', { privateFlow: false });
    await sync();
    assert.equal(balance(maker, A), 9975n * U);
    assert.equal(balance(maker, B), 9975n * U);
    assert.equal(balance(taker, B), 9975n * U);
    const transfer = await payment(maker, taker, A, 100n * U, 'private-transfer');
    await expectCallFailure('replay-private-transfer', infra.pool, railgunInterface.encodeFunctionData('transact', [[transfer]]) as Hex);
    await payment(maker, lp, A, 1000n * U, 'private-liquidity-add-A');
    await payment(maker, lp, B, 2000n * U, 'private-liquidity-add-B');

    const takerPays = 500n * U;
    const makerPays = quoteExactIn(takerPays, balance(lp, A), balance(lp, B));
    assert.equal(makerPays, 200n * U);
    const deadline = BigInt((await rpc.request<{ timestamp: Hex }>('eth_getBlockByNumber', ['latest', false])).timestamp) + 3600n;
    const swap = await Effect.runPromise(preparePrivateSwap({ maker: lp, taker, makerToken: A, takerToken: B, makerAmount: makerPays,
      takerAmount: takerPays, pool: infra.pool, adapter: infra.swap, tradeId: `0x${randomBytes(32).toString('hex')}`, deadline }).pipe(Effect.provide(proverLayer)));
    report.proofGenerationMs.push(...swap.proofGenerationMs.map((ms, i) => ({ label: `swap-leg-${i}`, ms })));
    const { tradeId, payment0, payment1 } = swap.quote;
    const conditions = await readContract<Hex>(rpc, infra.swap, artifacts.PrivateSwapVM.abi, 'conditions', [tradeId, deadline, payment0, payment1]);
    assert.equal(conditions, swap.params, 'TypeScript and Solidity condition hashes must agree');
    const encodeSwap = (legs: unknown[], time = deadline, p0 = payment0) => privateSwapInterface.encodeFunctionData('privateSwap', [legs, tradeId, time, p0, payment1]) as Hex;
    await expectCallFailure('isolated-swap-leg', infra.pool, railgunInterface.encodeFunctionData('transact', [[swap.legs[0]]]) as Hex);
    await expectCallFailure('missing-counterparty-leg', infra.swap, encodeSwap([swap.legs[0]]));
    await expectCallFailure('changed-payment-commitment', infra.swap, encodeSwap(swap.legs, deadline, hex32(1)));
    await expectCallFailure('expired-swap', infra.swap, encodeSwap(swap.legs, 1n));
    const corrupted = structuredClone(swap.legs[1]);
    corrupted.proof.a.x = BigInt(corrupted.proof.a.x.toString()) + 1n;
    const badData = encodeSwap([swap.legs[0], corrupted]);
    await expectCallFailure('invalid-second-proof', infra.swap, badData);
    await send(infra.swap, badData, 'atomic-rollback-invalid-second-proof', { expectFailure: true });
    for (const input of swap.inputs) assert.equal(await tree.isSpent(input.nullifier), false, 'Failed swap consumed an input');
    report.negativeChecks.push({ label: 'atomic-rollback', result: 'both-inputs-remain-unspent-after-failed-frame' });
    await send(infra.swap, swap.calldata, 'private-swap');
    await sync();
    assert.equal(balance(lp, A), 800n * U); assert.equal(balance(lp, B), 2500n * U);
    assert.equal(balance(taker, A), 300n * U); assert.equal(balance(taker, B), 9475n * U);
    await expectCallFailure('replay-private-swap', infra.swap, swap.calldata);
    await payment(lp, maker, A, 800n * U, 'private-liquidity-remove-A');
    await payment(lp, maker, B, 2000n * U, 'private-liquidity-remove-B-principal');
    await payment(lp, maker, B, 500n * U, 'private-liquidity-remove-B-proceeds');
    assert.equal(balance(lp, A), 0n); assert.equal(balance(lp, B), 0n);

    const input = select(maker, B, 500n * U);
    // Keep the withdrawal recipient distinct from the pool treasury (the deployer).
    const destination = privateKeyToAccount(keys.submitter).address;
    report.stage = 'public-unshield';
    const publicBefore = await readContract<bigint>(rpc, B, artifacts.TestToken.abi, 'balanceOf', [destination]);
    const unshield = await prove(maker, input, [outputs(maker, maker, input, 500n * U)[1]], { unshield: { to: destination, amount: 500n * U } });
    const exit = await privateTransport.send(infra.pool, railgunInterface.encodeFunctionData('transact', [[unshield.transaction]]) as Hex, 'public-unshield');
    report.flows.push({ ...exit, privateFlow: false });
    await save();
    assert.ok(exit.receipt.logs.some((log) => log.topics[0] === transferTopic));
    assert.equal(await readContract<bigint>(rpc, B, artifacts.TestToken.abi, 'balanceOf', [destination]) - publicBefore, 500n * U * 9975n / 10000n);
    await sync();

    report.stage = 'validation-prefix-gas-cap';
    const tooHeavy = await privateTransport.build(infra.pool, '0x', { verifyGas: 100_001n });
    let rejected = false;
    try { await rpc.request('eth_sendFrameTransaction', [toWire(tooHeavy)]); }
    catch (error) {
      if (!(error instanceof PrivacyError) || error.rpcReason !== 'validation-gas-limit') throw error;
      rejected = true;
    }
    assert.ok(rejected, 'Expected oversized validation prefix to be rejected');
    report.negativeChecks.push({ label: 'validation-prefix-gas-cap', result: 'rejected' });
    assert.equal(await codeHash(infra.aqua), aquaBefore); assert.equal(await codeHash(infra.pool), poolBefore);
    report.unchangedCodeHashes = { aqua: aquaBefore, railgunProxy: poolBefore };
    report.balances = Object.fromEntries(wallets.map((wallet) => [wallet.label, { A: balance(wallet, A).toString(), B: balance(wallet, B).toString() }]));
    report.stage = 'complete';
    report.status = 'passed';
    await save();
    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = `Private demo failed at ${report.stage ?? 'initialization'}; inspect the recorded receipts before retrying.`;
    await save();
    throw error;
  }
}
