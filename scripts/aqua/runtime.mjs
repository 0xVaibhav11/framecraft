import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineChain, http, getContractAddress, keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeTx } from '@forshtat/hegota-support/tx';
import { createFrameClient, privateKeyToFrameSigner, frame, getProfile, txHash, frameNetworks } from '@framepay/sdk';
import { createNetworkRpc, identifyNetwork, waitReceipt, assertDeploymentReceipt } from '../paymaster/runtime.mjs';
import { root } from './sources.mjs';

export const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
export const check = (condition, message) => { if (!condition) throw new Error(message); };
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/// Local-only journal: save each expected hash before broadcasting once; resume by inspecting it.
export async function openDemo({ runId = 'default' } = {}) {
  check(/^[a-z0-9][a-z0-9-]{0,31}$/.test(runId), 'Invalid demo run name.');
  const network = frameNetworks.local;
  const rpc = createNetworkRpc(network);
  const genesisHash = await identifyNetwork(rpc, network);
  const directory = runId === 'default' ? resolve(root, '.framepay/aqua') : resolve(root, '.framepay/aqua/runs', runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = resolve(directory, 'local.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  const statePath = resolve(directory, 'local.json');
  const release = async () => { await lock.close(); await unlink(lockPath); };
  try {
    let state;
    try { state = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    check(!state || state.genesisHash === genesisHash, 'Saved Aqua demo belongs to another genesis. Preserve its evidence before starting a new run.');
    state ??= { schemaVersion: 1, kind: 'aqua-recurring-frame-demo', network: 'local', gateway: network.rpcUrl,
      chainId: network.chainId, genesisHash, startedAt: new Date().toISOString(), status: 'setup', steps: {} };
    state.runId = runId;
    const save = async () => {
      const temporary = `${statePath}.${process.pid}.tmp`;
      await writeFile(temporary, json(state), { mode: 0o600 });
      await rename(temporary, statePath);
    };
    const accounts = {};
    for (const name of ['maker', 'taker']) {
      const keyPath = resolve(directory, `${name}.key`);
      let key;
      try { key = (await readFile(keyPath, 'utf8')).trim(); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        check(!state[name], `Saved ${name} key missing; no replacement generated.`);
        key = generatePrivateKey();
        await writeFile(keyPath, key + '\n', { flag: 'wx', mode: 0o600 });
      }
      const account = privateKeyToAccount(key);
      check(!state[name] || state[name] === account.address, 'Account journal mismatch.');
      state[name] = account.address;
      accounts[name] = { account, signer: privateKeyToFrameSigner(key) };
    }
    await save();
    const client = createFrameClient({ profile: network.profile,
      chain: defineChain({ id: 1337, name: network.name, nativeCurrency: { name: 'Test ETH', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [network.rpcUrl] } } }), transport: http(network.rpcUrl, { retryCount: 0, timeout: 10_000 }) });
    const profile = getProfile(network.profile);
    const nonce = async account => {
      const latest = await rpc('eth_getTransactionCount', [account.address, 'latest']);
      const pending = await rpc('eth_getTransactionCount', [account.address, 'pending']);
      check(BigInt(latest) === BigInt(pending), 'Demo account has pending canonical transactions. Inspect them before continuing.');
      return BigInt(latest);
    };
    async function fundMaker() {
      if (!state.faucet) {
        state.faucet = { status: 'requesting' };
        await save();
        const result = await rpc('skandha_explorer_faucet', [state.maker]);
        check(/^0x[0-9a-fA-F]{64}$/.test(result?.txHash), 'Invalid faucet response.');
        state.faucet = { status: 'requested', hash: result.txHash };
        await save();
      }
      check(state.faucet.hash, 'Faucet response is uncertain; inspect the maker balance before retrying.');
      const receipt = await waitReceipt(rpc, state.faucet.hash);
      check(receipt.status === '0x1', 'Maker faucet transfer reverted.');
      state.faucet.status = 'included';
      await save();
    }
    async function rawStep(name, { to, data = '0x', gas = 16_777_216n }) {
      let step = state.steps[name];
      const intent = keccak256(data);
      if (!step) {
        const account = accounts.maker.account;
        const n = await nonce(account);
        const raw = await account.signTransaction({ chainId: 1337, nonce: Number(n), type: 'legacy', gas,
          gasPrice: 2_000_000n, ...(to ? { to } : {}), data, value: 0n });
        step = state.steps[name] = { hash: keccak256(raw), intent, to: to ?? null, type: '0x0', status: 'submission-uncertain',
          ...(to ? {} : { address: getContractAddress({ from: account.address, nonce: n }) }) };
        await save();
        check(await rpc('eth_sendRawTransaction', [raw]) === step.hash, 'Raw submission hash mismatch.');
      }
      check(step.intent === intent && step.to === (to ?? null), `Saved step ${name} has a different intent.`);
      if (!step.receipt) {
        step.receipt = await waitReceipt(rpc, step.hash);
        step.status = step.receipt.status === '0x1' ? 'included' : 'reverted';
        await save();
        check(step.receipt.status === '0x1', `${name} reverted.`);
        if (step.address) assertDeploymentReceipt(step.receipt, step.address);
        await save();
      }
      check(step.receipt.status === '0x1', `${name} previously reverted.`);
      if (step.address) {
        const code = await rpc('eth_getCode', [step.address, 'latest']);
        check(code !== '0x' && (!step.codeHash || step.codeHash === keccak256(code)), `${name} deployment code mismatch.`);
        step.codeHash = keccak256(code);
        await save();
      }
      console.log(`${name}: ${step.hash}`);
      return step;
    }
    async function frameStep(name, actor, calls, paymaster, { canonical = false } = {}) {
      let step = state.steps[name];
      const intent = keccak256(new TextEncoder().encode(json({ actor, calls, paymaster: paymaster ?? null, canonical })));
      if (!step) {
        const { account, signer } = accounts[actor];
        const frames = [frame(profile, 'VERIFY', { scope: paymaster ? 'EXECUTION' : 'EXECUTION_AND_PAYMENT', execution: 30_000n })];
        if (paymaster) frames.push(frame(profile, 'VERIFY', { target: paymaster, scope: 'PAYMENT', execution: 50_000n }));
        for (const call of calls) frames.push(frame(profile, 'SENDER', { target: call.to, data: call.data,
          execution: call.execution ?? 600_000n, state: call.state ?? 1_500_000n }));
        const prepared = await client.prepareFrameTransaction({ sender: account.address, frames,
          nonceSeq: await nonce(account), maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 1_000_000n });
        const signed = await client.signFrameTransaction({ transaction: prepared, signer });
        step = state.steps[name] = { hash: txHash(profile, signed), intent, type: '0x06', sender: account.address,
          payer: paymaster ?? account.address, frameCount: frames.length, route: canonical ? 'canonical' : 'standard-alt-mempool', status: 'submission-uncertain' };
        await save();
        console.log(`Submitting ${name}: ${step.hash}`);
        const returned = canonical ? await rpc('eth_sendRawTransaction', [encodeTx(profile, signed)])
          : await client.sendFrameTransaction({ transaction: signed });
        check(returned === step.hash, 'Frame submission hash mismatch.');
      }
      check(step.intent === intent, `Saved frame step ${name} has a different intent.`);
      if (!step.receipt) {
        step.receipt = await client.waitForFrameReceipt({ hash: step.hash, expectedFrameCount: step.frameCount, timeoutMs: 120_000 });
        const transaction = await rpc('eth_getTransactionByHash', [step.hash]);
        check(transaction?.hash === step.hash && BigInt(transaction.type) === 6n && transaction.blockHash === step.receipt.blockHash,
          'Expected an included type-0x06 transaction matching its receipt.');
        if (!canonical) step.admission = await rpc('skandha_explorer_getTransaction', [step.hash]);
        step.status = 'verified';
        await save();
      }
      check(step.receipt.status === '0x1' && step.receipt.frameReceipts.length === step.frameCount
        && step.receipt.frameReceipts.every(frame => frame.status === '0x1'), `${name} contains failed frames.`);
      console.log(`${name}: ${step.frameCount} successful frames in block ${BigInt(step.receipt.blockNumber)}`);
      return step;
    }
    async function evidence() {
      const directory = resolve(root, 'evidence/aqua');
      await mkdir(directory, { recursive: true });
      const path = resolve(directory, `local-${Date.now()}.json`);
      await writeFile(path, json(state), { flag: 'wx' });
      console.log(`Evidence: ${path}`);
      return path;
    }
    return { state, rpc, client, save, release, fundMaker, rawStep, frameStep, evidence };
  } catch (error) { await release(); throw error; }
}
