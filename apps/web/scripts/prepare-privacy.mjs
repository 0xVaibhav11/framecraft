// Build the existing privacy worker for the static editor and copy the verified Falcon signer.
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = path.join(root, 'apps/poc/public/ethfalcon');
const pins = JSON.parse(await readFile(path.join(root, 'config/ethfalcon.json'), 'utf8'));
let manifest;
try { manifest = JSON.parse(await readFile(path.join(source, 'build.json'), 'utf8')); }
catch { throw new Error('Build the passkey signer first: bun run quantum:bootstrap && bun run quantum:build (requires Emscripten 3.1.74).'); }
if (manifest.commit !== pins.commit || manifest.cSourceSha256 !== pins.cSourceSha256 || manifest.emscripten !== pins.emscripten
  || createHash('sha256').update(await readFile(path.join(source, 'falcon.mjs'))).digest('hex') !== manifest.moduleSha256)
  throw new Error('Falcon build does not match its source pin or artifact digest. Run bun run quantum:build.');
const target = path.join(root, 'apps/web/public/ethfalcon');
await mkdir(target, { recursive: true });
for (const name of ['falcon.mjs', 'build.json', 'LICENSE.txt']) await copyFile(path.join(source, name), path.join(target, name));
await copyFile(path.join(root, 'scripts/quantum/worker.mjs'), path.join(target, 'worker.mjs'));
execFileSync(process.execPath, ['scripts/private/browser/build.mjs', '--web'], { cwd: root, stdio: 'inherit' });
