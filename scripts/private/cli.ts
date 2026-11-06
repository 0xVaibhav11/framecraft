import { execFileSync } from 'node:child_process';
import { mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Effect } from 'effect';
import { makeRpcClient, rpcUrl, requireDevnetChain, closeProverWorkers, attempt, PrivacyError } from '@framepay/privacy';
import { setupSources } from './sources.ts';
import { prepareArtifacts } from './artifacts.ts';
import { buildContracts } from './build.ts';
import { identities, infrastructure } from './deploy.ts';
import { runDemo } from './demo.ts';
import { writeReport } from './report.ts';
import { frameNetworks } from '@framepay/sdk';
import { runtime, root } from './files.ts';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'setup') { await setupSources(); await prepareArtifacts(); await buildContracts(); return; }
  if (command === 'build') { await buildContracts(); return; }
  if (command === 'test-contracts' || command === 'test-proofs') {
    await buildContracts();
    if (command === 'test-proofs') await prepareArtifacts();
    const compiler = process.env.FRAMEPAY_PRIVATE_SOLC;
    execFileSync('forge', ['test', '--offline', '--root', resolve(root, 'contracts/private'),
      ...(compiler ? ['--use', compiler] : []),
      ...(command === 'test-proofs' ? ['--ffi', '--match-contract', 'RealRailgunTest'] : [])],
      { stdio: 'inherit', env: { ...process.env, FRAMEPAY_REAL_PROOFS: command === 'test-proofs' ? 'true' : 'false' } });
    return;
  }
  if (command === 'report') { await writeReport(); return; }
  if (!['demo', 'deploy'].includes(command ?? '')) throw new Error('Usage: cli.ts setup|build|deploy|demo|report|test-contracts|test-proofs');
  const options = { allowRemote: process.env.FRAMEPAY_PRIVATE_RPC !== undefined };
  const endpoint = rpcUrl(process.env.FRAMEPAY_PRIVATE_RPC ?? 'http://127.0.0.1:14337/rpc', options);
  const rpc = makeRpcClient(endpoint, fetch, options);
  const remote = !['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname);
  await Effect.runPromise(requireDevnetChain(rpc, remote ? frameNetworks.devnet.genesisHash : undefined));
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const lockfile = resolve(runtime, 'run.lock');
  // Serialize local nonce ownership and deployment journals. A stale lock is never silently removed.
  const lock = await open(lockfile, 'wx', 0o600);
  try {
    await lock.writeFile(String(process.pid));
    const artifacts = await buildContracts();
    const circuit = command === 'demo' ? await prepareArtifacts() : undefined;
    const keys = await identities(rpc);
    const infra = await infrastructure(rpc, keys, artifacts);
    if (circuit) { await runDemo(rpc, artifacts, circuit, keys, infra, endpoint); await writeReport(); console.log('PASS: FramePay private transfers, swaps and maker inventory'); }
    else console.log('Private infrastructure deployed:', infra.swap);
  } finally { await lock.close(); await unlink(lockfile); }
}

const program = Effect.acquireUseRelease(
  Effect.succeed(undefined),
  () => attempt('private command', main),
  () => Effect.promise(closeProverWorkers),
);
try { await Effect.runPromise(program); }
catch (error) {
  if (error instanceof PrivacyError) console.error(`${error.operation}: ${error.message}`);
  console.error('Private command failed. Check the configured gateway on chain 1337, source pins, circuit artifacts, and .framepay/private/runtime. No proof or wallet material has been logged.');
  process.exitCode = 1;
}
