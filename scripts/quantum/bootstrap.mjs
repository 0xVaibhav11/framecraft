import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from '../aqua/sources.mjs';
const pins = JSON.parse(await readFile(resolve(root, 'config/ethfalcon.json')));
const directory = resolve(root, 'vendor/ethfalcon');
try { await access(resolve(directory, '.git')); }
catch {
  execFileSync('git', ['clone', '--no-checkout', pins.repository, directory], { stdio: 'inherit' });
  execFileSync('git', ['checkout', '--detach', pins.commit], { cwd: directory, stdio: 'inherit' });
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim() !== pins.commit) throw new Error('Preserve and review the existing ETHFalcon checkout; its revision differs.');
execFileSync('git', ['submodule', 'update', '--init', 'lib/InterfaceVerifier'], { cwd: directory, stdio: 'inherit' });
console.log('Pinned ETHFalcon source ready. quantum:build requires Emscripten 3.1.74 (see docs/quantum-wallet.md).');
