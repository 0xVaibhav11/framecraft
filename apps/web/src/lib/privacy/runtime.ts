import {
  frame, frameNetworks, getProfile, quantumFactoryAbi, quantumFactoryArgs,
  quantumWalletAbi, registerQuantumPasskey, validateFalconKey, txHash,
  type FrameSigner, type QuantumCredential, type Frame,
} from '@framepay/sdk';
import { createPublicClient, encodeFunctionData, formatUnits, isAddress, keccak256, parseAbi, parseUnits, type Address, type Hex } from 'viem';
import type { ActionHandlerCtx, ActionHandlers } from '@evmcrispr/core';
import { PrivateBrowserSession } from '../../../../../scripts/private/browser/session';
import type { BrowserPrivateIntent, BrowserPrivateResult, BrowserPrivateSnapshot, Pocket } from '../../../../../scripts/private/browser/types';
import { collectPrivatePockets, legacyPockets, pocketList } from '../../../../../scripts/private/browser/pockets';
import deployment from '../../../../../config/private-wallet.json';
import quantum from '../../../../../config/quantum.json';
import paymasters from '../../../../../config/paymasters.json';
import { frameBudgets } from '../../../../poc/src/lib/frame-budgets';
import { frameClient, rpc, transportOf } from '../frame-rpc';
import type { SentFrameTransaction } from '../evml-frames';
import { privateAuthorizationArgs } from './authorization';
import { privateFrameRequests, privateFrameContext, materializePrivateFrames } from './frame-plan';
import { refusal, toFrames, frameBudgets as layoutBudgets } from '../evml-frame-layout.mjs';
import { PRIVATE_METHOD, validatePrivateIntent } from './requests';
import { quoteExactIn } from '../../../../../packages/privacy/src/quote';

export type PrivateScriptWallet = QuantumCredential & { address: Address; networkDomain: Hex; factory: Address; pockets?: Pocket[] };
type Pending = { hash: Hex; frameCount: number };
export type PrivateRuntimeState = { wallet?: PrivateScriptWallet; snapshot?: BrowserPrivateSnapshot; viewing: boolean; pending?: Pending;
  deploymentStatus?: 'checking' | 'deployed' | 'undeployed' | 'unknown'; deploymentError?: string };
const storageKey = `framepay:evml:privacy:${deployment.genesisHash}`;
const walletKey = `framepay:defi:devnet:${deployment.genesisHash}:passkey`;
const publicClient = () => createPublicClient({ transport: transportOf('devnet') });
const profile = getProfile('ethrex-eip8141-tracer');

export function parsePrivateWallet(value: unknown, origin: string): PrivateScriptWallet {
  if (!value || typeof value !== 'object') throw new Error('Invalid public wallet metadata.');
  const w = value as PrivateScriptWallet;
  if (!isAddress(w.address) || !isAddress(w.factory) || w.factory.toLowerCase() !== quantum.devnet.factory.toLowerCase()
    || w.networkDomain !== deployment.genesisHash || w.origin !== origin || w.rpId !== new URL(origin).hostname
    || typeof w.credentialId !== 'string' || !/^[A-Za-z0-9_-]{1,1400}$/.test(w.credentialId)
    || ![w.qx, w.qy].every(x => typeof x === 'string' && /^0x[\da-fA-F]{64}$/.test(x)))
    throw new Error('Use quantum wallet metadata for this devnet and the original passkey origin.');
  validateFalconKey(w.falconPublicKey);
  // Pick public fields explicitly; never persist arbitrary imported keys.
  return { address: w.address, factory: w.factory, networkDomain: w.networkDomain,
    ...(w.pockets === undefined ? {} : { pockets: pocketList([...new Set([...legacyPockets, ...pocketList(w.pockets)])]) }),
    origin: w.origin, rpId: w.rpId, credentialId: w.credentialId, qx: w.qx, qy: w.qy, falconPublicKey: [...w.falconPublicKey] };
}

export { privateAuthorizationArgs } from './authorization';

/** Host adapter: EVML only supplies public intents; the existing worker owns keys and proofs. */
export class PrivateScriptRuntime {
  state: PrivateRuntimeState = { viewing: false };
  private session: PrivateBrowserSession;
  private deploymentCheck = 0;
  constructor(private readonly changed: (state: PrivateRuntimeState) => void,
    private readonly record: (sent: SentFrameTransaction) => void) {
    this.session = new PrivateBrowserSession(viewing => {
      this.state = { ...this.state, viewing, ...(!viewing ? { snapshot: undefined } : {}) };
      this.publish();
    }, frameNetworks.devnet.rpcUrl);
  }
  private publish() { this.changed({ ...this.state }); }
  restore() {
    const saved = localStorage.getItem(`${storageKey}:pending`);
    if (saved) {
      const p = JSON.parse(saved) as Pending;
      if (!/^0x[\da-fA-F]{64}$/.test(p.hash) || !Number.isInteger(p.frameCount) || (p.frameCount < 2 || p.frameCount > 16)) throw new Error('Invalid pending private transaction record.');
      this.state.pending = p;
      this.record(p);
    }
    try {
      const raw = localStorage.getItem(walletKey);
      if (raw) this.state.wallet = parsePrivateWallet(JSON.parse(raw), location.origin);
    } finally { this.publish(); }
    if (this.state.wallet) void this.refreshWalletDeployment();
    // Reconcile saved submissions using a receipt; unknown ones keep their lock.
    if (this.state.pending) void this.inspect().catch(() => {});
  }
  lock() { this.session.lock(); }
  private saveWallet(wallet: PrivateScriptWallet) {
    localStorage.setItem(walletKey, JSON.stringify(wallet));
    this.lock(); this.state.wallet = wallet;
    void this.refreshWalletDeployment();
  }
  async refreshWalletDeployment() {
    const wallet = this.state.wallet;
    if (!wallet) return;
    const check = ++this.deploymentCheck;
    this.state = { ...this.state, deploymentStatus: 'checking', deploymentError: undefined }; this.publish();
    try {
      await this.checkDeployment();
      const code = await rpc<Hex>('devnet', 'eth_getCode', [wallet.address, 'latest']);
      if (check !== this.deploymentCheck || this.state.wallet !== wallet) return;
      this.state = { ...this.state, deploymentStatus: code === '0x' ? 'undeployed' : 'deployed' }; this.publish();
    } catch {
      if (check !== this.deploymentCheck || this.state.wallet !== wallet) return;
      this.state = { ...this.state, deploymentStatus: 'unknown', deploymentError: 'Could not check wallet deployment. Recheck when the gateway is available.' }; this.publish();
    }
  }
  private markDeployed(wallet: PrivateScriptWallet) {
    if (this.state.wallet !== wallet) return;
    ++this.deploymentCheck;
    this.state = { ...this.state, deploymentStatus: 'deployed', deploymentError: undefined }; this.publish();
  }
  importWallet(raw: string) {
    if (this.state.pending) throw new Error('Inspect the pending transaction before changing wallets.');
    const saved = JSON.parse(raw);
    this.saveWallet(parsePrivateWallet(saved.wallet ?? saved, location.origin));
  }
  async createWallet() {
    if (this.state.wallet || this.state.pending) throw new Error('A wallet is already loaded. Export its metadata before changing accounts.');
    await this.checkDeployment();
    const credential = await registerQuantumPasskey();
    const address = await publicClient().readContract({ address: quantum.devnet.factory as Address, abi: quantumFactoryAbi,
      functionName: 'predict', args: quantumFactoryArgs(credential, deployment.genesisHash as Hex) });
    this.saveWallet({ ...credential, address, factory: quantum.devnet.factory as Address, networkDomain: deployment.genesisHash as Hex });
  }
  private wallet() {
    if (!this.state.wallet) throw new Error('Create or import a quantum wallet in the private wallet panel first.');
    return this.state.wallet;
  }
  private withKnownPockets<T extends BrowserPrivateIntent>(intent: T): T {
    const wallet = this.wallet();
    const known: readonly string[] = wallet.pockets ?? legacyPockets;
    const pockets = collectPrivatePockets({ ...intent, pockets: [...new Set([...known, ...(intent.pockets ?? [])])] });
    if (pockets.some(name => !known.includes(name))) {
      // Pocket names are recovery metadata, never spending/viewing keys. Save before a spend can fund a new pocket.
      const updated = { ...wallet, pockets };
      localStorage.setItem(walletKey, JSON.stringify(updated));
      this.state.wallet = updated; this.publish();
    }
    return { ...intent, pockets };
  }
  private async checkDeployment() {
    const genesis = await rpc<{ hash: Hex }>('devnet', 'eth_getBlockByNumber', ['0x0', false]);
    if (genesis.hash !== deployment.genesisHash || genesis.hash !== quantum.devnet.genesisHash || genesis.hash !== paymasters.devnet.genesisHash)
      throw new Error('Private deployment belongs to another chain.');
    await Promise.all([
      [quantum.devnet.factory, quantum.devnet.factoryCodeHash],
      [quantum.devnet.verifier, quantum.devnet.verifierCodeHash],
      [paymasters.devnet.address, paymasters.devnet.codeHash],
    ].map(async ([address, hash]) => {
      if (keccak256(await rpc<Hex>('devnet', 'eth_getCode', [address, 'latest'])) !== hash) throw new Error('Private wallet deployment code mismatch.');
    }));
  }
  private assertIdle(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.state.pending) throw new Error(`Inspect pending transaction ${this.state.pending.hash} before sending another.`);
  }
  private async send(to: Address, data: Hex, signer: FrameSigner, ctx: Pick<ActionHandlerCtx, 'signal' | 'onLog' | 'onSent'>, deploying = false) {
    return this.sendFrames([
      frame(profile, 'VERIFY', { scope: 'EXECUTION', ...frameBudgets.account }),
      frame(profile, 'VERIFY', { target: paymasters.devnet.address as Address, scope: 'PAYMENT', ...frameBudgets.payment }),
      frame(profile, 'SENDER', { target: to, data, ...(deploying ? frameBudgets.deployment : frameBudgets.quantum) }),
    ], signer, ctx);
  }
  private async sendFrames(frames: Frame[], signer: FrameSigner, ctx: Pick<ActionHandlerCtx, 'signal' | 'onLog' | 'onSent'>) {
    this.assertIdle(ctx.signal);
    ctx.onLog('Checking devnet contracts…');
    await this.checkDeployment();
    const client = frameClient('devnet');
    ctx.onLog('Preparing sponsored transaction…');
    const transaction = await client.prepareFrameTransaction({ sender: signer.address, maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 1_000_000n, frames });
    const signed = await client.signFrameTransaction({ transaction, signer });
    ctx.signal?.throwIfAborted();
    const pending = { hash: txHash(profile, signed), frameCount: signed.frames.length };
    // Persist before submission: a timeout or reload must never lose the possible transaction hash.
    localStorage.setItem(`${storageKey}:pending`, JSON.stringify(pending));
    this.state.pending = pending; this.publish(); this.record({ ...pending, error: undefined, outcome: undefined });
    ctx.onLog(`Private transaction ${pending.hash} prepared; submitting…`);
    try {
      await client.sendFrameTransaction({ transaction: signed });
      ctx.onSent?.(pending.hash);
      ctx.onLog(`Transaction ${pending.hash} submitted; waiting for confirmation…`);
      const receipt = await client.waitForFrameReceipt({ hash: pending.hash, expectedFrameCount: pending.frameCount, signal: ctx.signal });
      this.record({ ...pending, receipt });
      this.clearPending();
      return receipt;
    } catch (error) {
      let inspectionError: unknown;
      try {
        // A lost submission response can still have a receipt or an explicit rejection.
        const receipt = await this.inspect();
        if (receipt) return receipt;
      } catch (cause) { inspectionError = cause; }
      if (!this.state.pending) throw inspectionError ?? error;
      const reason = error instanceof Error ? error.message.slice(0, 180) : 'Unknown submission error';
      const message = `Private submission needs inspection: ${pending.hash}. Do not rerun until its receipt is checked. ${reason}`;
      this.record({ ...pending, error: message });
      throw new Error(message);
    }
  }
  private clearPending() { localStorage.removeItem(`${storageKey}:pending`); this.state.pending = undefined; this.publish(); }
  async inspect() {
    const pending = this.state.pending;
    if (!pending) return;
    const client = frameClient('devnet');
    const receipt = await client.getFrameReceipt({ hash: pending.hash });
    if (!receipt) {
      // Rejected envelopes never get a receipt. Missing admission history alone
      // cannot prove rejection: a timeout or dropped entry may still execute.
      const admission = await client.getFrameAdmission({ hash: pending.hash }).catch(() => undefined);
      if (this.state.pending?.hash !== pending.hash) return;
      if (admission?.available && admission.outcome === 'rejected') {
        const failedRules = admission.checks.filter(check => check.verdict === 'fail').map(check => check.rule);
        const hint = failedRules.includes('gas-limit') ? ' Check the gas limits or use fewer private operations per frame:tx block.' : '';
        const message = `Transaction rejected by the gateway${failedRules.length ? ` (${failedRules.join(', ')})` : ''}: ${pending.hash}.${hint} The pending lock has been cleared; you can submit a new transaction.`;
        this.record({ ...pending, outcome: 'rejected', error: message });
        this.clearPending();
        throw new Error(message);
      }
      throw new Error(`Still pending or unknown: ${pending.hash}.`);
    }
    if (this.state.pending?.hash !== pending.hash) return;
    if (receipt.frameReceipts.length !== pending.frameCount) throw new Error('Unexpected frame receipt count.');
    this.record({ ...pending, receipt }); this.clearPending();
    const failed = receipt.frameReceipts.flatMap((frame, index) => frame.status !== '0x1' ? [index + 1] : []);
    if (receipt.status !== '0x1' || failed.length) throw new Error(`Transaction reverted${failed.length ? ` in frame(s) ${failed.join(', ')}` : ''}: ${pending.hash}. The pending lock has been cleared.`);
    await this.refreshWalletDeployment();
    return receipt;
  }
  async deploy(signer: FrameSigner, signal: AbortSignal, log: (message: string) => void) {
    const wallet = this.wallet(); this.assertIdle(signal);
    log('Checking wallet address and onchain deployment…');
    const predicted = await publicClient().readContract({ address: wallet.factory, abi: quantumFactoryAbi, functionName: 'predict', args: quantumFactoryArgs(wallet, wallet.networkDomain) });
    if (predicted.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('Wallet address does not match its public metadata.');
    if (await rpc<Hex>('devnet', 'eth_getCode', [wallet.address, 'latest']) !== '0x') { this.markDeployed(wallet); log('Wallet already deployed.'); return; }
    await this.send(wallet.factory, encodeFunctionData({ abi: quantumFactoryAbi, functionName: 'createWallet', args: quantumFactoryArgs(wallet, wallet.networkDomain) }), signer, { signal, onLog: log }, true);
    this.markDeployed(wallet);
    log(`Wallet deployed: ${wallet.address}`);
  }
  async faucet(signer: FrameSigner, signal: AbortSignal, log: (message: string) => void) {
    const wallet = this.wallet(); this.assertIdle(signal);
    log('Checking faucet availability…');
    const abi = parseAbi(['function claim(address wallet)', 'function nextClaimAt(address) view returns (uint256)']);
    const [next, block] = await Promise.all([
      publicClient().readContract({ address: deployment.faucet.address as Address, abi, functionName: 'nextClaimAt', args: [wallet.address] }),
      rpc<{ timestamp: Hex }>('devnet', 'eth_getBlockByNumber', ['latest', false]),
    ]);
    if (next > BigInt(block.timestamp)) throw new Error(`This wallet already received its FPA + FPB grant. Next claim: ${new Date(Number(next) * 1000).toLocaleString()}.`);
    if (keccak256(await rpc<Hex>('devnet', 'eth_getCode', [deployment.faucet.address, 'latest'])) !== deployment.faucet.codeHash) throw new Error('Faucet deployment mismatch.');
    if (await rpc<Hex>('devnet', 'eth_getCode', [wallet.address, 'latest']) === '0x') throw new Error('Deploy your quantum wallet first.');
    await this.send(deployment.faucet.address as Address, encodeFunctionData({ abi, functionName: 'claim', args: [wallet.address] }), signer, { signal, onLog: log });
  }
  private async submit(result: BrowserPrivateResult, signer: FrameSigner, ctx: ActionHandlerCtx) {
    const wallet = this.wallet();
    const args = privateAuthorizationArgs(wallet, result);
    if (!await publicClient().readContract({ address: wallet.address, abi: quantumWalletAbi, functionName: 'verify', args })) throw new Error('Private approval expired or wallet changed.');
    return this.send(wallet.address, encodeFunctionData({ abi: quantumWalletAbi, functionName: 'execute', args }), signer, ctx);
  }
  /** Materialize all private frames before signing/sending the enclosing envelope exactly once. */
  frameHandler(networkId: string, signer: FrameSigner): ActionHandlers['frame'] {
    return async (input, ctx) => {
      const action = structuredClone(input);
      if (networkId !== 'devnet') throw new Error('Select Framecraft devnet for private frame transactions.');
      const refused = refusal(action, signer.address);
      if (refused) throw new Error(refused);
      this.assertIdle(ctx.signal);
      const requests = privateFrameRequests(action);
      if (!requests.length) throw new Error('No private frames to prepare.');
      const wallet = this.wallet();
      const frameContext = privateFrameContext(action);
      const signal = ctx.signal ?? new AbortController().signal;
      const intent = this.withKnownPockets({ action: 'frame-batch', requests, frameContext });
      const result = await this.session.execute(wallet, intent, ctx.onLog, signal);
      signal.throwIfAborted();
      const specs = materializePrivateFrames(action, wallet, result);
      const first = result.batches![0];
      if (!await publicClient().readContract({ address: wallet.address, abi: quantumWalletAbi, functionName: 'verify', args: privateAuthorizationArgs(wallet, first) }))
        throw new Error('Private frame authorization expired or the wallet nonce changed.');
      // Later wallet nonces are consecutive and are verified by wallet.execute as the frames execute.
      const receipt = await this.sendFrames(toFrames(specs, layoutBudgets), signer, ctx);
      ctx.onLog(`:success:Private frame transaction ${receipt.transactionHash} confirmed in block ${BigInt(receipt.blockNumber)} (${requests.length} private operations, ${specs.length} frames).`);
      receipt.frameReceipts.forEach(({ status }, index) =>
        ctx.onLog(`${status === '0x1' ? ':success:' : ':warning:'}Frame ${index + 1} (${specs[index]?.mode ?? '?'}): ${status === '0x1' ? 'succeeded' : 'failed'}`));
      try { this.state.snapshot = await this.session.refresh(); this.publish(); }
      catch { this.state.snapshot = undefined; this.publish(); ctx.onLog('Confirmed; run privacy:scan to refresh balances.'); }
      return receipt;
    };
  }
  handler(networkId: string, signer: FrameSigner): ActionHandlers['wallet'] {
    return async (action, ctx) => {
      if (action.method !== PRIVATE_METHOD) throw new Error('This editor only supports privacy wallet requests.');
      if (networkId !== 'devnet') throw new Error('Select Framecraft devnet for private commands.');
      if (action.params.length !== 1) throw new Error('Invalid private command arguments.');
      const intent = validatePrivateIntent(action.params[0]);
      ctx.signal?.throwIfAborted();
      if (intent.action === 'lock') { this.lock(); ctx.onLog('Private balances locked.'); return; }
      this.assertIdle(ctx.signal);
      if (intent.action === 'quote') {
        const snapshot = await this.session.refresh();
        this.state.snapshot = snapshot; this.publish();
        const inventory = snapshot.balances[intent.inventory], spendable = snapshot.spendable[intent.inventory];
        if (!inventory || !spendable) throw new Error(`Unlock this local pocket first: privacy:scan --wallet ${intent.inventory}`);
        const a = parseUnits(inventory.A, 18), b = parseUnits(inventory.B, 18), input = parseUnits(intent.amount, 18);
        if (a <= 0n || b <= 0n) throw new Error(`Fund ${intent.inventory} with both tokens before quoting.`);
        const output = quoteExactIn(input, a, b);
        if (output <= 0n || output > parseUnits(spendable.A, 18)) throw new Error('Quote exceeds available single-note inventory or rounds to zero.');
        ctx.onLog(`Exact quote: ${intent.amount} FPB → ${formatUnits(output, 18)} FPA. Use --inventory ${intent.inventory} --expect "${formatUnits(output, 18)}"; a changed quote will be refused.`);
        return;
      }
      const signal = ctx.signal ?? new AbortController().signal;
      const request = this.withKnownPockets(intent);
      const canRefresh = this.session.active && request.pockets!.every(name => this.state.snapshot?.addresses[name]);
      const result = intent.action === 'scan' && canRefresh
        ? { snapshot: await this.session.refresh(), calls: [] }
        : await this.session.execute(this.wallet(), request, ctx.onLog, signal);
      signal.throwIfAborted();
      this.state.snapshot = result.snapshot; this.publish();
      if (intent.action === 'scan') { this.logSnapshot(result.snapshot, ctx.onLog); return; }
      const receipt = await this.submit(result, signer, ctx);
      ctx.onLog(`:success:Private ${intent.action} confirmed in block ${BigInt(receipt.blockNumber)}: ${receipt.transactionHash}`);
      // A refresh failure must not make a successful spend look failed or invite replay.
      try { this.state.snapshot = await this.session.refresh(); this.publish(); }
      catch { this.state.snapshot = undefined; this.publish(); ctx.onLog('Transaction confirmed; run privacy:scan to refresh balances.'); }
      return receipt;
    };
  }
  private logSnapshot(snapshot: BrowserPrivateSnapshot, log: (message: string) => void) {
    for (const pocket of Object.keys(snapshot.addresses))
      log(`${pocket}: ${snapshot.balances[pocket].A} FPA / ${snapshot.balances[pocket].B} FPB; single-note limits ${snapshot.spendable[pocket].A} / ${snapshot.spendable[pocket].B}; ${snapshot.addresses[pocket]}`);
  }
}
