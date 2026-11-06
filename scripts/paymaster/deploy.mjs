import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeDeployData, getContractAddress, isAddress, keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { networkFor, createNetworkRpc, identifyNetwork, waitReceipt, assertDeploymentReceipt, isHash, isQuantity } from './runtime.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
if (process.argv.length !== 4 || process.argv[2] !== '--network') throw new Error('Usage: npm run paymaster:deploy -- --network devnet|local|public');
const network = networkFor(process.argv[3]);
const rpc = createNetworkRpc(network);
const directory = resolve(root, '.framepay/paymaster');
const statePath = resolve(directory, `${network.id}.json`);
const keyPath = resolve(directory, `${network.id}.key`);
const registryPath = resolve(root, 'config/paymasters.json');
const funding = 10_000_000_000_000_000n; // 0.01 disposable test ETH; never automatically refilled.
const maxCost = 1_000_000_000_000_000n; // 0.001 ETH maximum transaction exposure.
const gas = 6_000_000n;
const gasPrice = 2_000_000n;
const report = { network: network.id, gateway: network.rpcUrl, observedAt: new Date().toISOString(), status: 'not-submitted' };
let lock;
async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function save(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
try {
  // Connectivity and genesis are checked before generating a key or requesting faucet funds.
  const genesisHash = await identifyNetwork(rpc, network);
  report.genesisHash = genesisHash;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  lock = await open(resolve(directory, 'deploy.lock'), 'wx', 0o600);
  const artifact = await readJson(resolve(root, 'contracts/artifacts/FramePayPaymaster.json'));
  const sourceHash = createHash('sha256').update(await readFile(resolve(root, 'contracts/src/FramePayPaymaster.sol'))).digest('hex');
  if (!artifact || artifact.sourceSha256 !== sourceHash || !/^0x[0-9a-f]+$/i.test(artifact.bytecode))
    throw new Error('Missing or stale paymaster artifact; run npm run paymaster:build.');
  let state = await readJson(statePath, null);
  if (state && (state.network !== network.id || state.genesisHash !== genesisHash || state.sourceSha256 !== sourceHash))
    throw new Error('Saved deployment belongs to a different genesis or source revision. Preserve its evidence and review before starting a new deployment.');
  let privateKey;
  try { privateKey = (await readFile(keyPath, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (state) throw new Error('Saved deployment key is missing; no replacement key was created.');
    privateKey = generatePrivateKey();
    await writeFile(keyPath, privateKey + '\n', { mode: 0o600, flag: 'wx' });
  }
  const account = privateKeyToAccount(privateKey);
  if (state && state.deployer !== account.address) throw new Error('Saved deployment account mismatch.');
  state ??= { network: network.id, gateway: network.rpcUrl, genesisHash, sourceSha256: sourceHash, deployer: account.address };
  await save(statePath, state);
  report.deployer = account.address;
  console.log(`Network: ${network.name}; deployer: ${account.address}`);

  if (!state.transactionHash) {
    const required = funding + gas * gasPrice;
    let balance = await rpc('eth_getBalance', [account.address, 'latest']);
    if (!isQuantity(balance)) throw new Error('Invalid deployment account balance.');
    if (BigInt(balance) < required) {
      if (!state.faucetRequested) {
        state.faucetRequested = true;
        await save(statePath, state);
        const response = await rpc('skandha_explorer_faucet', [account.address]);
        if (!isHash(response?.txHash)) throw new Error('Invalid faucet response; inspect the deployer balance before retrying.');
        state.faucetHash = response.txHash;
        await save(statePath, state);
      }
      if (!state.faucetHash) throw new Error('Previous faucet request has no recorded response. Fund the printed deployer address or inspect its balance; no repeat request was made.');
      const receipt = await waitReceipt(rpc, state.faucetHash);
      if (receipt.status !== '0x1') throw new Error('Faucet transfer reverted.');
      balance = await rpc('eth_getBalance', [account.address, 'latest']);
      if (!isQuantity(balance) || BigInt(balance) < required) throw new Error('Faucet funds do not cover the fixed deployment budget.');
    }
    const latest = await rpc('eth_getTransactionCount', [account.address, 'latest']);
    const pending = await rpc('eth_getTransactionCount', [account.address, 'pending']);
    if (!isQuantity(latest) || !isQuantity(pending) || BigInt(latest) !== BigInt(pending) || BigInt(latest) > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('Deployment account nonce is invalid or already has a pending transaction.');
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [maxCost] });
    const raw = await account.signTransaction({ chainId: network.chainId, nonce: Number(BigInt(latest)), type: 'legacy', gas, gasPrice, data, value: funding });
    state.transactionHash = keccak256(raw);
    state.address = getContractAddress({ from: account.address, nonce: BigInt(latest) });
    state.fundingWei = funding.toString();
    state.maxTransactionCostWei = maxCost.toString();
    state.status = 'submission-uncertain';
    await save(statePath, state); // Record the hash before broadcast, never regenerate a new nonce after an ambiguous send.
    report.transactionHash = state.transactionHash;
    report.status = state.status;
    const returnedHash = await rpc('eth_sendRawTransaction', [raw]);
    if (returnedHash !== state.transactionHash) throw new Error('Deployment response differs from the expected hash. Re-run to inspect the saved hash.');
  }
  report.transactionHash = state.transactionHash;
  report.status = 'awaiting-receipt';
  const receipt = await waitReceipt(rpc, state.transactionHash);
  if (!isAddress(state.address)) throw new Error('Invalid saved deployment address.');
  assertDeploymentReceipt(receipt, state.address);
  const code = await rpc('eth_getCode', [state.address, 'latest']);
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) throw new Error('No deployed paymaster code found.');
  if (state.codeHash && state.codeHash !== keccak256(code)) throw new Error('Recorded deployed code changed.');
  const record = { network: network.id, gateway: network.rpcUrl, chainId: network.chainId, genesisHash,
    address: state.address, transactionHash: state.transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    codeHash: keccak256(code), sourceSha256: sourceHash, fundingWei: funding.toString(), maxTransactionCostWei: maxCost.toString(),
    policy: 'Open test sponsorship; anyone may consume the finite budget.', explorerUrl: network.explorerUrl ? `${network.explorerUrl}/tx/${state.transactionHash}` : null };
  const registry = await readJson(registryPath, { local: null, public: null });
  registry[network.id] = record;
  await save(registryPath, registry);
  await save(statePath, { ...state, status: 'deployed', codeHash: record.codeHash });
  Object.assign(report, record, { status: 'deployed' });
  console.log(JSON.stringify(record, null, 2));
} catch (error) {
  // Do not print transport objects, signed payloads, keys, or arbitrary RPC bodies.
  report.error = String(error.message).replace(/0x[0-9a-fA-F]{64}\b/g, '[redacted]').slice(0, 500);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  const evidence = resolve(root, '.framepay/reports/paymaster');
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, `${network.id}-${Date.now()}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  if (lock) { await lock.close(); await unlink(resolve(directory, 'deploy.lock')); }
}
