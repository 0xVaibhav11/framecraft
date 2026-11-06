import { mkdir, readFile, realpath, symlink, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline development convenience only. Published SDK code never refers to the workshop filesystem.
const root = fileURLToPath(new URL('../', import.meta.url));
const cfg = JSON.parse(await readFile(resolve(root, 'config/local-devnet.json'), 'utf8'));
const expected = { typescript: '7.0.2', viem: '2.57.11', '@forshtat/hegota-support': '0.0.1' };
async function link(target, destination) {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await lstat(destination);
    if (await realpath(destination) === await realpath(target)) return;
    throw new Error(`Refusing to replace existing dependency: ${destination}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await symlink(target, destination);
}
for (const [name, version] of Object.entries(expected)) {
  const source = resolve(root, cfg.workshopPath, 'node_modules', name);
  const metadata = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
  if (metadata.version !== version) throw new Error(`Expected ${name}@${version}, found ${metadata.version}`);
  await link(source, resolve(root, 'node_modules', name));
}
await link(resolve(root, 'node_modules/typescript/bin/tsc'), resolve(root, 'node_modules/.bin/tsc'));
await link(resolve(root, 'packages/sdk'), resolve(root, 'node_modules/@framepay/sdk'));
console.log('Linked pinned installed dependencies and the local SDK workspace; no workshop files were modified.');
