import { resolve } from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { encodeDeployData, encodeFunctionData, parseAbi, keccak256, type Address, type Hex } from 'viem';
import { readContract, railgunABI, railgunInterface, waitReceipt, check, type RpcClient, type NativeReceipt } from '@framepay/privacy';
import { readJson, readOptional, saveJson, root, runtime } from './files.ts';
import type { Artifacts, Artifact } from './build.ts';

export interface Keys { deployer: Hex; submitter: Hex }
export interface Infrastructure {
  pool: Address; proxy: Address; t3: Address; t4: Address; impl: Address;
  aqua: Address; tokenA: Address; tokenB: Address; swap: Address;
  startBlock: Hex; genesis: Hex; swapBuild: Hex;
}
type DeploymentJournal = Partial<Infrastructure> & { upgraded?: boolean; unpaused?: boolean; initialized?: boolean; verifier?: boolean };
export function assertSuccess(receipt: NativeReceipt): void {
  check(receipt.status === '0x1' && (receipt.frameReceipts ?? []).every((frame) => frame.status === '0x1'), 'Deployment transaction failed');
}
export async function identities(rpc: RpcClient): Promise<Keys> {
  const file = resolve(runtime, 'submission-keys.json');
  const keys = await readOptional<Keys>(file) ?? { deployer: generatePrivateKey(), submitter: generatePrivateKey() };
  await saveJson(file, keys);
  for (const key of Object.values(keys)) {
    const account = privateKeyToAccount(key);
    if (BigInt(await rpc.request<Hex>('eth_getBalance', [account.address, 'latest'])) < 10n ** 16n) {
      const funded = await rpc.request<{ txHash: Hex }>('skandha_explorer_faucet', [account.address]);
      assertSuccess(await waitReceipt(rpc, funded.txHash));
    }
  }
  return keys;
}
export async function legacy(rpc: RpcClient, key: Hex, data: Hex, to?: Address): Promise<NativeReceipt> {
  const account = privateKeyToAccount(key);
  const gas = BigInt(await rpc.request<Hex>('eth_estimateGas', [{ from: account.address, to, data, gas: '0x3938700' }])) * 11n / 10n;
  const raw = await account.signTransaction({ chainId: 1337, nonce: Number(await rpc.request<Hex>('eth_getTransactionCount', [account.address, 'pending'])),
    type: 'legacy', to, data, gas, gasPrice: 2_000_000n, value: 0n });
  const receipt = await waitReceipt(rpc, await rpc.request<Hex>('eth_sendRawTransaction', [raw]));
  assertSuccess(receipt);
  return receipt;
}
export async function deploy(rpc: RpcClient, key: Hex, artifact: Artifact, args: readonly unknown[] = []): Promise<NativeReceipt> {
  return legacy(rpc, key, encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args }));
}
const hashes = {
  proxy: '0x13954e0d1af4c619efbd502299e78e116d1309b2b85c15ac6fe09838bb8622aa',
  t3: '0x22f522952985c00705187839388aa76c80a7684f186f29a47c05bba3a17765e6',
  t4: '0x1e7e34c103de436502520ee4d38b9ad1879645c8baf0547ab092bb034cfef679',
  impl: '0x12e5f2bb0d2d3bf66ba4ad115da3605a5e46103c4ad208baf3662b039f661d97',
};
export async function infrastructure(rpc: RpcClient, keys: Keys, artifacts: Artifacts, directory = runtime): Promise<Infrastructure> {
  const file = resolve(directory, 'deployments.json');
  const state: DeploymentJournal = await readOptional<DeploymentJournal>(file) ?? {};
  const save = () => saveJson(file, state);
  const owner = privateKeyToAccount(keys.deployer).address;
  const genesis = (await rpc.request<{ hash: Hex }>('eth_getBlockByNumber', ['0x0', false])).hash;
  check(!state.genesis || state.genesis === genesis, 'Devnet genesis changed; archive the runtime journal before redeploying');
  state.genesis = genesis;
  for (const name of ['proxy', 't3', 't4', 'impl', 'aqua', 'tokenA', 'tokenB', 'swap'] as const) {
    if (state[name]) check(await rpc.request<Hex>('eth_getCode', [state[name], 'latest']) !== '0x', 'Deployment code missing; archive runtime after a chain reset');
  }
  for (const name of ['proxy', 't3', 't4', 'impl'] as const) {
    if (state[name]) continue;
    const artifact = await readJson<{ input: Hex }>(resolve(root, `config/private/railgun/${hashes[name]}.json`));
    let input = artifact.input;
    if (name === 'proxy') input = (input.slice(0, -64) + owner.slice(2).toLowerCase().padStart(64, '0')) as Hex;
    if (name === 'impl') {
      for (const [old, relocated] of [['F5fE83643dd42d408c19B938866fA441C6c52563', state.t3], ['afd3Fc0396f793B35E433Bbe0e1160329bF0ABd3', state.t4]] as const) {
        check(relocated !== undefined && input.toLowerCase().split(old.toLowerCase()).length - 1 === 1, 'Expected one Poseidon library relocation');
        input = input.replace(new RegExp(old, 'gi'), relocated!.slice(2)) as Hex;
      }
    }
    const receipt = await legacy(rpc, keys.deployer, input);
    check(!!receipt.contractAddress, 'Missing deployment address');
    state[name] = receipt.contractAddress!;
    if (name === 'proxy') state.startBlock = receipt.blockNumber;
    await save();
    console.log(`RAILGUN ${name}: ${state[name]}`);
  }
  const admin = parseAbi(['function upgrade(address)', 'function unpause()']);
  if (!state.upgraded) {
    await legacy(rpc, keys.deployer, encodeFunctionData({ abi: admin, functionName: 'upgrade', args: [state.impl!] }), state.proxy);
    state.upgraded = true; await save();
  }
  if (!state.unpaused) {
    await legacy(rpc, keys.deployer, encodeFunctionData({ abi: admin, functionName: 'unpause' }), state.proxy);
    state.unpaused = true; await save();
  }
  if (!state.initialized) {
    await legacy(rpc, keys.deployer, railgunInterface.encodeFunctionData('initializeRailgunLogic', [owner, 25, 25, 25, owner]) as Hex, state.proxy);
    state.initialized = true; await save();
  }
  const verificationKeys = await readJson<{ nullifiers: number; commitments: number; verifyingKey: readonly unknown[] }[]>(resolve(root, 'config/private/railgun/railgun-verification-keys.json'));
  const key = verificationKeys.find((entry) => entry.nullifiers === 1 && entry.commitments === 2);
  check(!!key, 'Missing 1x2 verification key');
  if (!state.verifier) {
    await legacy(rpc, keys.deployer, railgunInterface.encodeFunctionData('setVerificationKey', [1, 2, key!.verifyingKey]) as Hex, state.proxy);
    state.verifier = true; await save();
  }
  state.pool = state.proxy;
  await save();
  const actual = await readContract<{ artifactsIPFSHash: string }>(rpc, state.pool!, railgunABI, 'getVerificationKey', [1n, 2n]);
  check(actual.artifactsIPFSHash === key!.verifyingKey[0], 'Unexpected onchain verification key');
  const deployments: [keyof Pick<Infrastructure, 'aqua' | 'tokenA' | 'tokenB'>, Artifact, readonly unknown[]][] = [
    ['aqua', artifacts.Aqua, []], ['tokenA', artifacts.TestToken, ['FramePay Private A', 'FPA', owner]], ['tokenB', artifacts.TestToken, ['FramePay Private B', 'FPB', owner]],
  ];
  for (const [name, artifact, args] of deployments) {
    if (state[name]) continue;
    const receipt = await deploy(rpc, keys.deployer, artifact, args);
    check(!!receipt.contractAddress, 'Missing deployment address');
    state[name] = receipt.contractAddress!;
    await save();
  }
  const buildHash = keccak256(artifacts.PrivateSwapVM.bytecode);
  if (state.swapBuild !== buildHash) {
    const receipt = await deploy(rpc, keys.deployer, artifacts.PrivateSwapVM, [state.aqua, state.tokenA, owner, state.pool]);
    check(!!receipt.contractAddress, 'Missing swap deployment');
    state.swap = receipt.contractAddress!; state.swapBuild = buildHash; await save();
  }
  for (const token of [state.tokenA!, state.tokenB!]) {
    const allowance = await readContract<bigint>(rpc, token, artifacts.TestToken.abi, 'allowance', [owner, state.pool]);
    if (allowance < 10n ** 24n) await legacy(rpc, keys.deployer,
      encodeFunctionData({ abi: artifacts.TestToken.abi, functionName: 'approve', args: [state.pool, 2n ** 256n - 1n] }), token);
  }
  return state as Infrastructure;
}
