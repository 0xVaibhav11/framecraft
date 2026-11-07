import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Effect } from 'effect';
import { parseUnits, formatUnits, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { frameNetworks, txHash, getProfile } from '@framepay/sdk';
import { toWire } from '@forshtat/hegota-support/rpc';
import { PrivateTree, makeWallet, scan, balance, select, outputs, shieldRequest, PrivateProver, PrivateProverLive,
  preparePrivateTransfer, preparePrivateSwap, quoteExactIn, makeFrameTransport, makeRpcClient, requireDevnetChain,
  closeProverWorkers, railgunInterface, waitReceipt, assertNativeReceipt, type PrivateWallet, type NativeReceipt } from '@framepay/privacy';
import { local, runtime, readOptional, saveJson } from './files.ts';
import { setupSources } from './sources.ts';
import { prepareArtifacts } from './artifacts.ts';
import { buildContracts } from './build.ts';
import { identities, infrastructure, type Infrastructure, type Keys } from './deploy.ts';
import { validatePrivateAction, type PrivateActionRequest, type PrivatePocState, type WalletName } from './poc-types.ts';

const directory = resolve(local, 'poc');
const stateFile = resolve(directory, 'state.json');
const walletFile = resolve(runtime, 'poc-wallets.json');
const names: WalletName[] = ['maker', 'taker', 'inventory'];

async function run(input: PrivateActionRequest) {
  validatePrivateAction(input);
  const network = frameNetworks.devnet;
  const rpc = makeRpcClient(network.rpcUrl, fetch, { allowRemote: true });
  await Effect.runPromise(requireDevnetChain(rpc, network.genesisHash));
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const lockPath = resolve(runtime, 'run.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  let state: PrivatePocState;
  try {
    await lock.writeFile(String(process.pid));
    const saved = await readOptional<PrivatePocState>(stateFile);
    if (saved && saved.genesis !== network.genesisHash) throw new Error('Private wallets belong to another genesis.');
    state = saved ?? { revision: randomUUID(), network: 'devnet', rpcUrl: network.rpcUrl, genesis: network.genesisHash, initialized: false, stage: 'ready', activity: [] };
  } catch (error) { await lock.close(); await unlink(lockPath); throw error; }
  const save = async (stage: string) => { state!.stage = stage; state!.rpcUrl = network.rpcUrl; await saveJson(stateFile, state); };
  try {
    if (input.action !== 'inspect' && input.action !== 'initialize' && input.expectedRevision !== state.revision) throw new Error('The balances changed after review. Review the action again.');
    if (state.pending && input.action !== 'inspect') throw new Error('Inspect the pending transaction before another action.');
    delete state.error;
    await save(input.action === 'initialize' ? 'Preparing verified sources and test contracts' : 'Synchronizing private wallets');
    let infra: Infrastructure;
    let keys: Keys;
    if (input.action === 'initialize') {
      if (state.initialized) throw new Error('Test wallets are already initialized.');
      await setupSources();
      await prepareArtifacts();
      const artifacts = await buildContracts();
      keys = await identities(rpc);
      infra = await infrastructure(rpc, keys, artifacts);
      await saveJson(resolve(directory, 'infrastructure.json'), infra);
    } else {
      if (!state.initialized) throw new Error('Initialize the privacy test wallets first.');
      const savedInfra = await readOptional<Infrastructure>(resolve(directory, 'infrastructure.json'));
      const savedKeys = await readOptional<Keys>(resolve(runtime, 'submission-keys.json'));
      if (!savedInfra || !savedKeys) throw new Error('Private test runtime is unavailable.');
      infra = savedInfra; keys = savedKeys;
    }
    if (infra.genesis !== network.genesisHash) throw new Error('Private deployment genesis mismatch.');
    const tree = new PrivateTree(rpc, infra.pool, infra.startBlock);
    await tree.sync();
    let secrets = await readOptional<Record<WalletName, string>>(walletFile);
    if (!secrets && state.initialized) throw new Error('Wallet recovery data is missing. Do not create replacement keys.');
    const wallets = {} as Record<WalletName, PrivateWallet>;
    for (const name of names) wallets[name] = await makeWallet(name, tree, secrets?.[name]);
    if (!secrets) { secrets = Object.fromEntries(names.map(name => [name, wallets[name].mnemonic])) as Record<WalletName, string>; await saveJson(walletFile, secrets); }
    const sync = async () => {
      await tree.sync();
      for (const wallet of Object.values(wallets)) await scan(wallet, tree);
      state!.balances = Object.fromEntries(names.map(name => [name, { A: formatUnits(balance(wallets[name], infra.tokenA), 18), B: formatUnits(balance(wallets[name], infra.tokenB), 18) }])) as PrivatePocState['balances'];
      state!.spendable = Object.fromEntries(names.map(name => [name, Object.fromEntries(([['A', infra.tokenA], ['B', infra.tokenB]] as const).map(([label, address]) => [label,
        formatUnits(wallets[name].notes.filter(note => note.note.tokenData.tokenAddress.toLowerCase() === address.toLowerCase()).reduce((largest, note) => note.note.value > largest ? note.note.value : largest, 0n), 18)]))])) as PrivatePocState['spendable'];
    };
    state.contracts = { pool: infra.pool, swap: infra.swap, aqua: infra.aqua, tokenA: infra.tokenA, tokenB: infra.tokenB };
    state.submitter = privateKeyToAccount(keys.submitter).address;
    state.initialized = true;
    await sync();
    const settle = async (receipt: NativeReceipt) => {
      const pending = state!.pending!;
      if (receipt.transactionHash.toLowerCase() !== pending.hash.toLowerCase()) throw new Error('Receipt hash mismatch.');
      const ok = receipt.status === '0x1' && receipt.frameReceipts?.length === 2 && receipt.frameReceipts.every(frame => frame.status === '0x1');
      const entry = { ...pending, status: ok ? 'confirmed' as const : 'failed' as const, blockNumber: receipt.blockNumber };
      state!.activity = [entry, ...state!.activity.filter(item => item.hash !== entry.hash)].slice(0, 50);
      delete state!.pending;
      state!.revision = randomUUID();
      await save(ok ? 'Confirmed · all frames succeeded' : 'Included · execution failed');
      return ok;
    };
    if (input.action === 'inspect') {
      if (state.pending) {
        const receipt = await rpc.request<NativeReceipt | null>('eth_getTransactionReceipt', [state.pending.hash]);
        if (!receipt) { await save('No receipt yet · submission remains blocked'); return; }
        await settle(receipt); await sync();
      }
      await save('Wallet balances synchronized'); return;
    }
    if (input.action === 'initialize') { state.revision = randomUUID(); await save('Test wallets ready'); return; }
    const quantity = parseUnits(input.amount!, 18);
    const token = input.token === 'B' ? infra.tokenB : infra.tokenA;
    const sender = wallets[input.wallet ?? 'maker'];
    const receiver = wallets[input.receiver ?? 'taker'];
    const requireNote = (name: WalletName, asset: 'A' | 'B', amount: bigint) => {
      const largest = state.spendable![name][asset];
      if (amount > parseUnits(largest, 18)) throw new Error(`The amount exceeds the largest unspent note (${largest} FP${asset}). Split the transfer into separate actions.`);
    };
    if (input.action === 'swap') requireNote('taker', 'B', quantity);
    else if (input.action !== 'shield') requireNote(input.action === 'add-inventory' ? 'maker' : input.action === 'remove-inventory' ? 'inventory' : input.wallet ?? 'maker', input.token ?? 'A', quantity);
    let data: Hex; let target: Address = infra.pool; let key = keys.submitter;
    if (input.action === 'shield') {
      key = keys.deployer;
      data = railgunInterface.encodeFunctionData('shield', [[await shieldRequest(sender, token, quantity)]]) as Hex;
    } else {
      await save('Generating Groth16 proof · this can take a minute');
      const prover = PrivateProverLive(await prepareArtifacts());
      if (input.action === 'swap') {
        const output = quoteExactIn(quantity, balance(wallets.inventory, infra.tokenA), balance(wallets.inventory, infra.tokenB));
        requireNote('inventory', 'A', output);
        if (output !== parseUnits(input.expectedOutput!, 18)) throw new Error('The swap quote changed. Review the current output again.');
        const block = await rpc.request<{ timestamp: Hex }>('eth_getBlockByNumber', ['latest', false]);
        const proved = await Effect.runPromise(preparePrivateSwap({ maker: wallets.inventory, taker: wallets.taker, makerToken: infra.tokenA, takerToken: infra.tokenB,
          makerAmount: output, takerAmount: quantity, pool: infra.pool, adapter: infra.swap,
          tradeId: `0x${randomBytes(32).toString('hex')}`, deadline: BigInt(block.timestamp) + 600n }).pipe(Effect.provide(prover)));
        data = proved.calldata; target = infra.swap;
      } else if (input.action === 'unshield') {
        const inputNote = select(sender, token, quantity);
        const change = outputs(sender, sender, inputNote, quantity)[1];
        const proved = await Effect.runPromise(Effect.gen(function* () {
          return yield* (yield* PrivateProver).prove(sender, inputNote, [change], { unshield: { to: input.recipient as Address, amount: quantity } });
        }).pipe(Effect.provide(prover)));
        data = railgunInterface.encodeFunctionData('transact', [[proved.transaction]]) as Hex;
      } else {
        const from = input.action === 'add-inventory' ? wallets.maker : input.action === 'remove-inventory' ? wallets.inventory : sender;
        const to = input.action === 'add-inventory' ? wallets.inventory : input.action === 'remove-inventory' ? wallets.maker : receiver;
        if (from === to) throw new Error('Choose two different wallets.');
        const proved = await Effect.runPromise(preparePrivateTransfer(from, to, token, quantity).pipe(Effect.provide(prover)));
        data = proved.calldata;
      }
    }
    const transaction = await makeFrameTransport(rpc, key).build(target, data);
    const hash = txHash(getProfile('ethrex-eip8141-tracer'), transaction);
    state.pending = { hash, label: input.action, at: new Date().toISOString(), status: 'pending', frameCount: 2 };
    state.activity = [state.pending, ...state.activity].slice(0, 50);
    // Persist the exact hash before the one permitted broadcast, including across process restarts.
    await save('Submitting frame transaction');
    const returned = await rpc.request<Hex>('eth_sendFrameTransaction', [toWire(transaction)]);
    if (returned.toLowerCase() !== hash.toLowerCase()) throw new Error('Gateway returned an unexpected transaction hash.');
    await save('Waiting for block inclusion');
    const receipt = await waitReceipt(rpc, hash);
    const ok = await settle(receipt);
    await sync();
    if (!ok) throw new Error('A frame reverted. Inspect the transaction before preparing another action.');
    assertNativeReceipt(receipt);
    await save('Confirmed · all frames succeeded');
  } catch (error) {
    // Never copy raw engine/prover errors into the public snapshot (they can contain inputs).
    const known = error instanceof Error && /^(The amount exceeds|The balances changed|Inspect the pending|Test wallets are already|Initialize the privacy|Private test runtime|Private deployment genesis|Wallet recovery data|The swap quote changed|Choose two different|A frame reverted)/.test(error.message);
    state.error = known ? (error as Error).message : state.pending ? 'Submission outcome needs inspection. The recorded hash has been preserved.' : 'The action could not complete. Check the amount, available single-note balance, verified artifacts and gateway.';
    await save('Action needs attention');
    throw new Error(state.error);
  } finally { await lock.close(); await unlink(lockPath); }
}

try {
  let raw = ''; for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 4096) throw new Error('Request too large'); }
  const input: unknown = JSON.parse(raw); validatePrivateAction(input);
  await run(input);
} catch { console.error('Private POC action failed; inspect the public POC state. No wallet material has been logged.'); process.exitCode = 1; }
finally { await closeProverWorkers(); }
