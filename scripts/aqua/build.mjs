import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, checkSources, sourceTree, sha256 } from './sources.mjs';

const pins = await checkSources();
execFileSync('forge', ['build', '--offline', '--skip', 'test'], { cwd: resolve(root, 'contracts/aqua'), stdio: 'inherit' });
const directory = resolve(root, 'contracts/aqua/artifacts');
await mkdir(directory, { recursive: true });
const manifest = { compiler: pins.compiler, evmVersion: 'prague', viaIR: true, optimizerRuns: 600,
  sourceTreeSha256: await sourceTree('contracts/aqua/src'), pins, artifacts: {} };
for (const name of ['Aqua', 'FramePayRecurringSwapVM', 'DemoToken', 'FramePayCreate2Factory', 'AppTestToken', 'FramePayTransferGuard']) {
  const artifact = JSON.parse(await readFile(resolve(root, `contracts/aqua/out/${name}.sol/${name}.json`)));
  if ((artifact.deployedBytecode.object.length - 2) / 2 > 24_576) throw new Error(`${name} exceeds EIP-170 runtime size.`);
  const value = { contractName: name, abi: artifact.abi, bytecode: artifact.bytecode.object, metadata: artifact.metadata };
  const bytes = JSON.stringify(value, null, 2) + '\n';
  await writeFile(resolve(directory, `${name}.json`), bytes);
  manifest.artifacts[name] = sha256(bytes);
}
await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Built official Aqua, FramePayRecurringSwapVM and fixed-supply demo tokens; verified source fingerprints and runtime sizes.');
