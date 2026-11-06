import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function sourceTree(path) {
  const entries = [];
  async function walk(directory, prefix = '') {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix + item.name;
      if (item.isDirectory()) await walk(resolve(directory, item.name), relative + '/');
      else if (item.name.endsWith('.sol')) entries.push([relative, sha256(await readFile(resolve(directory, item.name)))]);
    }
  }
  await walk(resolve(root, path));
  return sha256(JSON.stringify(entries));
}
export async function checkSources() {
  const pins = JSON.parse(await readFile(resolve(root, 'config/aqua-sources.json')));
  for (const item of pins.sources) {
    if (await sourceTree(item.path) !== item.solidityTreeSha256) throw new Error(`Aqua source fingerprint differs: ${item.name}`);
    if (item.version) {
      const pkg = JSON.parse(await readFile(resolve(root, 'vendor/framepay-deps/node_modules', item.name, 'package.json')));
      if (pkg.version !== item.version) throw new Error(`Unexpected dependency version: ${item.name}`);
    }
  }
  const solcPackage = JSON.parse(await readFile(resolve(root, 'vendor/framepay-deps/node_modules/solc/package.json')));
  if (solcPackage.version !== pins.compiler) throw new Error('Expected solc 0.8.30.');
  return pins;
}
