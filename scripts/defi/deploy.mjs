import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, http, encodeDeployData, encodeFunctionData, encodeAbiParameters, parseAbiParameters, keccak256, getContractAddress } from 'viem';
import { root, checkSources, sourceTree, sha256 } from '../aqua/sources.mjs';
import { openDemo, check } from '../aqua/runtime.mjs';

await checkSources();
const manifest = JSON.parse(await readFile(resolve(root, 'contracts/aqua/artifacts/manifest.json')));
check(manifest.sourceTreeSha256 === await sourceTree('contracts/aqua/src'), 'Run npm run aqua:build before deploying the app.');
const artifacts = {};
for (const [name, hash] of Object.entries(manifest.artifacts)) {
  const bytes = await readFile(resolve(root, `contracts/aqua/artifacts/${name}.json`));
  check(sha256(bytes) === hash, `Artifact mismatch: ${name}`);
  artifacts[name] = JSON.parse(bytes);
}
const demo = await openDemo({ runId: 'defi-app' });
const { state, rpc, save } = demo;
const client = createPublicClient({ transport: http(state.gateway, { retryCount: 0 }) });
const read = (name, address, functionName, args = []) => client.readContract({ address, abi: artifacts[name].abi, functionName, args });
const call = (name, to, functionName, args = []) => ({ to, data: encodeFunctionData({ abi: artifacts[name].abi, functionName, args }) });
try {
  state.build = manifest;
  await demo.fundMaker();
  const registry = JSON.parse(await readFile(resolve(root, 'config/paymasters.json')))[state.network];
  check(registry?.genesisHash === state.genesisHash, 'Deploy the selected network paymaster first.');
  check(keccak256(await rpc('eth_getCode', [registry.address, 'latest'])) === registry.codeHash, 'Paymaster code mismatch.');
  const deploy = async (name, args) => (await demo.rawStep(name, { data: encodeDeployData({ abi: artifacts[name].abi, bytecode: artifacts[name].bytecode, args }) })).address;
  const aqua = await deploy('Aqua', []);
  const factory = await deploy('FramePayCreate2Factory', []);
  const guard = await deploy('FramePayTransferGuard', []);
  const usd = (await demo.rawStep('AppUSD', { data: encodeDeployData({ ...artifacts.AppTestToken, args: ['FramePay Dollar', 'fpUSD', 6, 1000_000_000n] }) })).address;
  const asset = (await demo.rawStep('AppAsset', { data: encodeDeployData({ ...artifacts.AppTestToken, args: ['FramePay Asset', 'fpASSET', 18, 100n * 10n ** 18n] }) })).address;
  const salt = keccak256(new TextEncoder().encode('FramePay DeFi app v1'));
  const initcode = encodeDeployData({ ...artifacts.FramePayRecurringSwapVM, args: [aqua, asset, state.maker] });
  const scopedSalt = keccak256(encodeAbiParameters(parseAbiParameters('address, bytes32'), [state.maker, salt]));
  const router = getContractAddress({ opcode: 'CREATE2', from: factory, salt: scopedSalt, bytecode: initcode });
  await demo.frameStep('deployRouter', 'maker', [{ ...call('FramePayCreate2Factory', factory, 'deploy', [initcode, salt]), execution: 2_000_000n, state: 40_000_000n }], undefined, { canonical: true });
  await demo.frameStep('seedTokens', 'maker', [call('AppTestToken', usd, 'claim')], registry.address);
  if (!state.policy) {
    const start = BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp);
    state.policy = { buyToken: asset, schedule: (start | (60n << 64n) | ((start + 30n * 86400n) << 96n)).toString(),
      periodBudget: '100000000', totalBudget: '1000000000', buyUnits: '1000000000000000000', spendUnits: '10000000', salt };
    await save();
  }
  const policy = Object.fromEntries(Object.entries(state.policy).map(([key, value]) => [key, ['buyToken', 'salt'].includes(key) ? value : BigInt(value)]));
  const order = await read('FramePayRecurringSwapVM', router, 'buildOrder', [state.maker, usd, policy]);
  const orderHash = await read('FramePayRecurringSwapVM', router, 'hash', [order]);
  const orderData = encodeAbiParameters(parseAbiParameters('(address maker, uint256 traits, bytes data)'), [order]);
  await demo.frameStep('seedPosition', 'maker', [call('AppTestToken', usd, 'approve', [aqua, 1000_000_000n]),
    call('Aqua', aqua, 'ship', [router, orderData, [asset, usd], [0n, 1000_000_000n]])], registry.address);
  const contracts = { aqua, router, guard, usd, asset };
  const codeHashes = {};
  for (const [name, address] of Object.entries(contracts)) {
    const code = await rpc('eth_getCode', [address, 'latest']);
    check(code !== '0x', `${name} has no deployed code.`);
    codeHashes[name] = keccak256(code);
  }
  const record = { network: demo.state.network, genesisHash: state.genesisHash, contracts, codeHashes,
    seedPosition: { name: 'Community buy pool', order: { ...order, traits: order.traits.toString() }, orderHash, policy: state.policy },
    deployment: state.steps.deployRouter.hash, seededAt: state.steps.seedPosition.hash };
  await writeFile(resolve(root, 'config/defi.json'), JSON.stringify({ ...JSON.parse(await readFile(resolve(root, 'config/defi.json'))), [demo.state.network]: record }, null, 2) + '\n');
  state.status = 'verified';
  state.app = record;
  await save();
  console.log(`DeFi app contracts ready. Router: ${router}; funded position: ${orderHash}`);
} catch (error) {
  state.status = 'incomplete';
  state.error = error.shortMessage ?? error.message;
  await save();
  console.error(state.error);
  process.exitCode = 1;
} finally { try { await demo.evidence(); } finally { await demo.release(); } }
