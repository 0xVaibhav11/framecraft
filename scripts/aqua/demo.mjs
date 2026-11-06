import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, http, encodeDeployData, encodeFunctionData, encodeAbiParameters, parseAbiParameters,
  decodeEventLog, formatUnits, keccak256, getContractAddress } from 'viem';
import { root, checkSources, sourceTree, sha256 } from './sources.mjs';
import { openDemo, check, pause } from './runtime.mjs';
import { demoOptions } from './options.mjs';

const options = demoOptions(process.argv.slice(2));
await checkSources();
const artifactDirectory = resolve(root, 'contracts/aqua/artifacts');
const manifest = JSON.parse(await readFile(resolve(artifactDirectory, 'manifest.json')));
check(manifest.sourceTreeSha256 === await sourceTree('contracts/aqua/src'), 'Aqua artifact is stale; run npm run aqua:build.');
const artifacts = {};
for (const [name, hash] of Object.entries(manifest.artifacts)) {
  const bytes = await readFile(resolve(artifactDirectory, `${name}.json`));
  check(sha256(bytes) === hash, `Artifact hash mismatch: ${name}`);
  artifacts[name] = JSON.parse(bytes);
}

const demo = await openDemo(options);
const { state, rpc, save } = demo;
const publicClient = createPublicClient({ transport: http(state.gateway, { retryCount: 0, timeout: 10_000 }) });
const read = (name, address, functionName, args = []) => publicClient.readContract({ address, abi: artifacts[name].abi, functionName, args });
const call = (name, to, functionName, args) => ({ to, data: encodeFunctionData({ abi: artifacts[name].abi, functionName, args }) });
const blockTime = async () => BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp);
try {
  if (state.manifestHash && state.manifestHash !== sha256(JSON.stringify(manifest))) {
    // New helper artifacts may be added; deployed/used contract artifacts must stay byte-for-byte identical.
    check(Object.entries(state.build.artifacts).every(([name, hash]) => manifest.artifacts[name] === hash), 'Existing contract artifacts changed during a journaled run.');
    state.buildHistory ??= [];
    state.buildHistory.push(state.build);
  }
  state.manifestHash = sha256(JSON.stringify(manifest));
  state.build = manifest;
  delete state.error;
  await save();
  if (state.status === 'verified') {
    console.log('This journaled demo is already verified. Existing transaction hashes and evidence are preserved.');
  } else {
    const registry = JSON.parse(await readFile(resolve(root, 'config/paymasters.json'))).local;
    check(registry && registry.genesisHash === state.genesisHash, 'Deploy the local paymaster for this genesis first.');
    const sponsorCode = await rpc('eth_getCode', [registry.address, 'latest']);
    check(sponsorCode !== '0x' && keccak256(sponsorCode) === registry.codeHash, 'Recorded local paymaster code does not match.');
    check(!state.paymaster || state.paymaster === registry.address, 'Paymaster changed during the demo.');
    state.paymaster = registry.address;
    console.log(`Local maker ${state.maker}; zero-ETH taker ${state.taker}; paymaster ${state.paymaster}`);
    const peers = await rpc('skandha_explorer_peers');
    const info = await rpc('skandha_explorer_info');
    check(info.bundlingMode === 'auto' || peers.length > 0, 'Local gateway has manual bundling and no peers. Restore local miner connectivity first.');
    check(BigInt(await rpc('eth_getBalance', [state.paymaster, 'latest'])) > 100_000_000_000_000n, 'Local test sponsor needs funding.');
    await demo.fundMaker();

    async function deploy(stepName, name, args) {
      return (await demo.rawStep(stepName, { data: encodeDeployData({ abi: artifacts[name].abi, bytecode: artifacts[name].bytecode, args }) })).address;
    }
    const aqua = await deploy('deployAqua', 'Aqua', []);
    const usd = await deploy('deployUSD', 'DemoToken', ['FramePay Test USD', 'fpUSD', 6, state.maker, 100_000_000n]);
    const asset = await deploy('deployAsset', 'DemoToken', ['FramePay Test Asset', 'fpASSET', 18, state.taker, 100n * 10n ** 18n]);
    const factory = await deploy('deployFactory', 'FramePayCreate2Factory', []);
    const initcode = encodeDeployData({ abi: artifacts.FramePayRecurringSwapVM.abi,
      bytecode: artifacts.FramePayRecurringSwapVM.bytecode, args: [aqua, asset, state.maker] });
    const salt = keccak256(new TextEncoder().encode(state.startedAt));
    const scopedSalt = keccak256(encodeAbiParameters(parseAbiParameters('address, bytes32'), [state.maker, salt]));
    const router = getContractAddress({ opcode: 'CREATE2', from: factory, salt: scopedSalt, bytecode: initcode });
    // Official SwapVM runtime needs ~32M state gas on this EIP-8037 devnet. Use a canonical
    // type-0x06 creation frame, beyond the standard sidecar's 25M total admission budget.
    // All position and fill transactions below use the standard alternative mempool.
    await demo.frameStep('deployRecurringSwapVMFrame', 'maker', [{ ...call('FramePayCreate2Factory', factory, 'deploy', [initcode, salt]),
      execution: 2_000_000n, state: 40_000_000n }], undefined, { canonical: true });
    const routerCode = await rpc('eth_getCode', [router, 'latest']);
    check(routerCode !== '0x', 'CREATE2 router has no code.');
    state.steps.deployRecurringSwapVMFrame.address = router;
    state.steps.deployRecurringSwapVMFrame.codeHash = keccak256(routerCode);
    state.contracts = { aqua, router, spendToken: usd, buyToken: asset };
    await save();

    await demo.frameStep('approveTaker', 'taker', [call('DemoToken', asset, 'approve', [router, 100n * 10n ** 18n])], state.paymaster);
    if (!state.policy) {
      const start = await blockTime() + 30n;
      state.policy = { buyToken: asset, schedule: (start | (60n << 64n) | ((start + 3600n) << 96n)).toString(),
        periodBudget: '10000000', totalBudget: '25000000', buyUnits: '1000000000000000000', spendUnits: '10000000',
        salt: keccak256(new TextEncoder().encode(state.startedAt)), start: start.toString(), period: '60', expiry: (start + 3600n).toString() };
      await save();
    }
    const p = state.policy;
    check(await blockTime() < BigInt(p.expiry), 'This demo position expired; preserved transaction hashes must be reviewed before starting another run.');
    const policy = { buyToken: asset, schedule: BigInt(p.schedule), periodBudget: BigInt(p.periodBudget),
      totalBudget: BigInt(p.totalBudget), buyUnits: BigInt(p.buyUnits), spendUnits: BigInt(p.spendUnits), salt: p.salt };
    const order = await read('FramePayRecurringSwapVM', router, 'buildOrder', [state.maker, usd, policy]);
    const orderHash = await read('FramePayRecurringSwapVM', router, 'hash', [order]);
    const orderData = encodeAbiParameters(parseAbiParameters('(address maker, uint256 traits, bytes data)'), [order]);
    state.order = order;
    state.orderHash = orderHash;
    await save();
    await demo.frameStep('shipPosition', 'maker', [call('DemoToken', usd, 'approve', [aqua, BigInt(p.totalBudget)]),
      call('Aqua', aqua, 'ship', [router, orderData, [asset, usd], [0n, BigInt(p.totalBudget)]])]);

    const takerData = await read('FramePayRecurringSwapVM', router, 'buildTakerData', [asset, usd, 10n ** 18n, Number(p.expiry)]);
    const balances = async () => {
      const [makerUSD, makerAsset, takerUSD, takerAsset, takerETH, payerETH] = await Promise.all([
        read('DemoToken', usd, 'balanceOf', [state.maker]), read('DemoToken', asset, 'balanceOf', [state.maker]),
        read('DemoToken', usd, 'balanceOf', [state.taker]), read('DemoToken', asset, 'balanceOf', [state.taker]),
        rpc('eth_getBalance', [state.taker, 'latest']), rpc('eth_getBalance', [state.paymaster, 'latest']),
      ]);
      return { makerUSD, makerAsset, takerUSD, takerAsset, takerETH: BigInt(takerETH), payerETH: BigInt(payerETH) };
    };
    if (!state.balancesBefore) {
      state.balancesBefore = await balances();
      check(state.balancesBefore.takerETH === 0n, 'Demo taker must start without ETH.');
      await save();
    }
    async function waitUntil(timestamp) {
      let lastMessage = 0;
      while (await blockTime() < timestamp) {
        if (Date.now() - lastMessage > 15_000) { console.log(`Waiting for local block timestamp ${timestamp} (recurring schedule).`); lastMessage = Date.now(); }
        await pause(3000);
      }
    }
    async function fill(name, amount) {
      const step = await demo.frameStep(name, 'taker', [call('FramePayRecurringSwapVM', router, 'swap', [order, amount, takerData])], state.paymaster);
      // Persist the actual chain receipt and token-transfer logs, not simulation results.
      const receipt = await rpc('eth_getTransactionReceipt', [step.hash]);
      const events = receipt.logs.filter(log => log.address.toLowerCase() === router.toLowerCase()).flatMap(log => {
        try { return [decodeEventLog({ abi: artifacts.FramePayRecurringSwapVM.abi, data: log.data, topics: log.topics })]; }
        catch { return []; }
      });
      const swapped = events.find(event => event.eventName === 'Swapped');
      check(swapped && swapped.args.orderHash === orderHash && swapped.args.maker.toLowerCase() === state.maker.toLowerCase()
        && swapped.args.taker.toLowerCase() === state.taker.toLowerCase() && swapped.args.amountOut === amount, 'Missing or mismatched SwapVM settlement event.');
      step.rawReceipt = receipt;
      step.settlement = swapped.args;
      step.recurringBuy = events.find(event => event.eventName === 'RecurringBuyFilled')?.args;
      check(step.recurringBuy, 'Missing recurring-buy accounting event.');
      await save();
      console.log(`Settled ${formatUnits(amount, 6)} fpUSD for ${formatUnits(swapped.args.amountIn, 18)} fpASSET via Aqua.`);
    }
    await waitUntil(BigInt(p.start));
    await fill('fillSixUSD', 6_000_000n);
    await fill('fillFourUSD', 4_000_000n);
    check(String(state.steps.fillSixUSD.recurringBuy.epoch) === String(state.steps.fillFourUSD.recurringBuy.epoch),
      'First partial fills crossed a period boundary; do not claim same-period exhaustion.');

    async function expectCapacityRejection(label) {
      let rejected = false;
      try { await read('FramePayRecurringSwapVM', router, 'quote', [order, 1n, takerData]); }
      catch (error) {
        let cursor = error;
        while (cursor) {
          if (cursor.data?.errorName === 'CapacityExceeded') rejected = true;
          cursor = cursor.cause;
        }
        if (!rejected) throw error;
      }
      check(rejected, `${label} unexpectedly accepted another fill.`);
      state[label] = { method: 'eth_call', error: 'CapacityExceeded', observedAt: new Date().toISOString() };
      await save();
    }
    if (!state.periodLimitCheck) await expectCapacityRejection('periodLimitCheck');
    const epoch0 = BigInt(state.steps.fillFourUSD.recurringBuy.epoch);
    await waitUntil(BigInt(p.start) + (epoch0 + 1n) * BigInt(p.period));
    await fill('fillNextPeriod', 10_000_000n);
    const epoch1 = BigInt(state.steps.fillNextPeriod.recurringBuy.epoch);
    check(epoch1 > epoch0, 'Expected a new period for the recurring fill.');
    await waitUntil(BigInt(p.start) + (epoch1 + 1n) * BigInt(p.period));
    await fill('fillFinalBudget', 5_000_000n);
    await expectCapacityRejection('totalLimitCheck');

    state.balancesAfter = await balances();
    const before = state.balancesBefore;
    const after = state.balancesAfter;
    check(BigInt(before.makerUSD) - after.makerUSD === 25_000_000n && after.takerUSD - BigInt(before.takerUSD) === 25_000_000n,
      'Spend-token balance deltas do not match the four fills.');
    check(after.makerAsset - BigInt(before.makerAsset) === 25n * 10n ** 17n
      && BigInt(before.takerAsset) - after.takerAsset === 25n * 10n ** 17n, 'Buy-token balance deltas do not match settlement.');
    check(after.takerETH === 0n, 'Taker unexpectedly has ETH.');
    check(after.payerETH < BigInt(before.payerETH), 'Paymaster balance did not decrease.');
    state.paymasterBalanceDecreaseWei = (BigInt(before.payerETH) - after.payerETH).toString();
    state.paymasterBalanceNote = 'Shared open test sponsor: concurrent sponsorship can also contribute to this balance decrease.';
    state.finalUsage = await read('FramePayRecurringSwapVM', router, 'usage', [orderHash]);
    check(BigInt(state.finalUsage[2]) === 25_000_000n, 'Total spending counter mismatch.');
    state.status = 'verified';
    await save();
    console.log('VERIFIED: four sponsored type-0x06 fills, 25 fpUSD exchanged for 2.5 fpASSET, period/total caps enforced, taker ETH stayed zero.');
  }
} catch (error) {
  state.status = 'incomplete';
  state.error = error.shortMessage ?? error.message ?? 'Demo failed';
  await save();
  console.error(state.error);
  process.exitCode = 1;
} finally {
  try { await demo.evidence(); }
  finally { await demo.release(); }
}
