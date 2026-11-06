import { readFile, mkdir, writeFile, open, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const json = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateConfig(cfg) {
  const url = new URL(cfg.gatewayUrl);
  invariant(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash,
  'This runner supports an uncredentialed loopback devnet gateway only.');
  invariant(cfg.chainId === 1337 && cfg.profile === 'ethrex-eip8141-tracer', 'Unsupported chain/profile.');
  for (const name of ['recipient', 'stakingRegistry', 'entryPoint']) {
    invariant(/^0x[0-9a-fA-F]{40}$/.test(cfg[name]), `Invalid ${name}.`);
  }
  for (const name of ['rpcTimeoutMs', 'receiptTimeoutMs', 'pollIntervalMs']) {
    invariant(Number.isSafeInteger(cfg[name]) && cfg[name] > 0, `Invalid ${name}.`);
  }
  invariant(/^\d+$/.test(cfg.transferWei) && BigInt(cfg.transferWei) > 0n
    && BigInt(cfg.transferWei) <= 1_000_000_000n, 'Smoke transfer must be at most 1 gwei.');
  invariant(/^\d+$/.test(cfg.maxFeePerGasWei) && BigInt(cfg.maxFeePerGasWei) > 0n
    && BigInt(cfg.maxFeePerGasWei) <= 2_000_000_000n, 'Smoke maxFeePerGas must be at most 2 gwei.');
  return cfg;
}

export async function loadConfig() {
  return validateConfig(JSON.parse(await readFile(resolve(root, 'config/local-devnet.json'), 'utf8')));
}

export function command(binary, args) {
  try {
    return { ok: true, value: execFileSync(binary, args, {
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024,
    }).trim() };
  } catch (error) {
    return { ok: false, error: { message: String(error.stderr || error.message).slice(0, 1500) } };
  }
}

export function safeError(error) {
  // Do not include arbitrary RPC response bodies, signed payloads, stack traces, or local key material.
  const message = String(error.message).replace(/0x[0-9a-f]{64}\b/gi, '[redacted 32-byte value]');
  return { code: error.code ?? 'ERROR', message: message.slice(0, 1000) };
}

export async function writeEvidence(label, value) {
  const directory = resolve(root, 'evidence/milestone-1');
  await mkdir(directory, { recursive: true });
  const name = `${new Date().toISOString().replaceAll(':', '-')}-${label}-${process.pid}.json`;
  const path = resolve(directory, name);
  await writeFile(path, json(value), { flag: 'wx' });
  return path;
}

export async function checkPins(cfg) {
  const lock = JSON.parse(await readFile(resolve(root, 'config/devnet-lock.json'), 'utf8'));
  const workshop = resolve(root, cfg.workshopPath);
  const checks = [];
  for (const [name, info] of Object.entries(lock.repositories)) {
    const actual = command('git', ['-C', resolve(workshop, info.path), 'rev-parse', 'HEAD']);
    checks.push({ name, expected: info.commit, actual: actual.value ?? null, matches: actual.value === info.commit });
  }
  for (const [file, expected] of Object.entries(lock.sha256)) {
    let actual = null;
    try { actual = sha256(await readFile(resolve(workshop, file))); } catch { /* recorded as mismatch */ }
    checks.push({ file, expected, actual, matches: expected === actual });
  }
  return { verified: checks.every((entry) => entry.matches), lock, checks };
}

export async function loadCodec(cfg) {
  const require = createRequire(resolve(root, cfg.workshopPath, 'package.json'));
  const fromWorkshop = (name) => import(pathToFileURL(require.resolve(name)).href);
  const [profiles, tx, wire, accounts] = await Promise.all([
    fromWorkshop('@forshtat/hegota-support/profiles'), fromWorkshop('@forshtat/hegota-support/tx'),
    fromWorkshop('@forshtat/hegota-support/rpc'), fromWorkshop('viem/accounts'),
  ]);
  return { profile: profiles.getProfile(cfg.profile), tx, wire, accounts };
}

export function createRpc(cfg, fetcher = fetch) {
  let id = 0;
  return async (method, params = []) => {
    const requestId = ++id;
    let response;
    try {
      response = await fetcher(cfg.gatewayUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        signal: AbortSignal.timeout(cfg.rpcTimeoutMs), redirect: 'error',
      });
    } catch {
      throw Object.assign(new Error(`Cannot reach gateway for ${method}; check local networking, Docker, and devnet uptime.`), { code: 'RPC_UNREACHABLE' });
    }
    invariant(response.ok, `HTTP ${response.status} from gateway for ${method}.`);
    const envelope = await response.json();
    invariant(envelope.jsonrpc === '2.0' && envelope.id === requestId, `Invalid JSON-RPC envelope for ${method}.`);
    if (envelope.error) {
      // No raw node error string: it may echo a signed request. Use the explorer's admission checks.
      throw Object.assign(new Error(`${method} rejected by gateway (RPC ${envelope.error.code}).`), { code: envelope.error.code });
    }
    invariant(Object.hasOwn(envelope, 'result'), `Missing RPC result for ${method}.`);
    return envelope.result;
  };
}

export async function probeGateway(cfg, rpc) {
  const chainId = await rpc('eth_chainId');
  invariant(BigInt(chainId) === BigInt(cfg.chainId), 'Wrong chain: refusing further checks/submission.');
  const [clientVersion, latestBlock, explorer, registryCode] = await Promise.all([
    rpc('web3_clientVersion'), rpc('eth_getBlockByNumber', ['latest', false]),
    rpc('skandha_explorer_info'), rpc('eth_getCode', [cfg.stakingRegistry, 'latest']),
  ]);
  invariant(latestBlock?.hash && latestBlock?.number, 'No usable latest block.');
  invariant(explorer?.chainId === cfg.chainId, 'Explorer chain does not match RPC chain.');
  invariant(typeof registryCode === 'string' && registryCode.length > 2, 'Staking registry has no deployed code.');
  return {
    chainId: Number(BigInt(chainId)), clientVersion,
    latestBlock: { hash: latestBlock.hash, number: latestBlock.number, timestamp: latestBlock.timestamp },
    sidecar: Object.fromEntries(['version', 'commit', 'protocolVersion', 'bootId', 'p2pEnabled', 'bundlingMode'].map((k) => [k, explorer[k]])),
    registryCodeSha256: sha256(registryCode), frameExecution: 'Not proven by connectivity; requires successful frame receipt.',
  };
}

export function buildSmokeTx(codec, cfg, sender, nonce) {
  const { tx, profile } = codec;
  return tx.newTx({
    chainId: cfg.chainId, sender, nonceSeq: nonce,
    fees: { maxFeePerGas: BigInt(cfg.maxFeePerGasWei) },
    signatures: [tx.secp256k1Placeholder(profile)],
    frames: [
      tx.frame(profile, 'VERIFY', { scope: 'EXECUTION_AND_PAYMENT', execution: 30_000n }),
      tx.frame(profile, 'SENDER', { target: cfg.recipient, execution: 50_000n, state: 200_000n, value: BigInt(cfg.transferWei) }),
    ],
  });
}

export function assertFrameReceipt(receipt, hash, frameCount = 2) {
  invariant(receipt && receipt.transactionHash?.toLowerCase() === hash.toLowerCase(), 'Receipt transaction hash mismatch.');
  invariant(receipt.blockHash && receipt.blockNumber, 'Receipt is not included in a block.');
  invariant(receipt.status === '0x1', 'Transaction execution failed.');
  invariant(Array.isArray(receipt.frameReceipts) && receipt.frameReceipts.length === frameCount, 'Missing or unexpected frame receipts.');
  invariant(receipt.frameReceipts.every((frame) => frame.status === '0x1'), 'One or more frames failed.');
  return receipt;
}

export async function waitForReceipt(rpc, hash, cfg) {
  const deadline = Date.now() + cfg.receiptTimeoutMs;
  while (Date.now() < deadline) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt) return assertFrameReceipt(receipt, hash);
    await new Promise((done) => setTimeout(done, cfg.pollIntervalMs));
  }
  throw new Error(`Inclusion timeout. Inspect ${hash} before sending anything again.`);
}

export async function getAdmissionEvidence(rpc, hash, { requireAccepted = true } = {}) {
  const detail = await rpc('skandha_explorer_getTransaction', [hash]);
  invariant(detail?.hash?.toLowerCase() === hash.toLowerCase(), 'Explorer transaction hash mismatch.');
  const admission = detail.admission;
  invariant(admission?.txHash?.toLowerCase() === hash.toLowerCase(), 'Missing admission evidence for this transaction.');
  if (requireAccepted) invariant(['accepted', 'included'].includes(admission.outcome), 'No accepted/included admission outcome.');
  return {
    outcome: admission.outcome, source: admission.source, at: admission.at,
    checks: (admission.checks ?? []).map(({ rule, verdict, frameIndex }) => ({ rule, verdict, frameIndex })),
    events: (detail.events ?? []).map(({ seq, at, kind, status, blockNumber }) => ({ seq, at, kind, status, blockNumber })),
  };
}

export async function acquireSubmissionLock() {
  const directory = resolve(root, '.framepay');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, 'smoke.lock');
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch { throw new Error('Another smoke run may be active. Inspect .framepay/smoke.lock and any pending transaction before retrying.'); }
  await handle.writeFile(json({ pid: process.pid, startedAt: new Date().toISOString() }));
  return async () => { await handle.close(); await unlink(path); };
}

export function imageInventory(cfg) {
  const compose = resolve(root, cfg.workshopPath, cfg.sidecarPath, 'deploy/local/compose.json');
  if (!existsSync(compose)) return { ok: false, error: { message: 'Local compose file missing.' } };
  // Docker's explicit projection avoids exporting container environments or local funding keys.
  const ids = command('docker', ['compose', '-f', compose, 'ps', '-q']);
  if (!ids.ok) return ids;
  if (!ids.value) return { ok: false, error: { message: 'No running local devnet containers.' } };
  const containers = [];
  for (const id of ids.value.split(/\s+/)) {
    const result = command('docker', ['inspect', '--format', '{{json .Name}} {{json .Image}}', id]);
    if (!result.ok) return result;
    const [name, imageId] = result.value.split(' ').map(JSON.parse);
    const digestResult = command('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', imageId]);
    if (!digestResult.ok) return digestResult;
    containers.push({ name, imageId, repoDigests: JSON.parse(digestResult.value) ?? [] });
  }
  return { ok: true, containers };
}
