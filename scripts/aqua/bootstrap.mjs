import { execFileSync } from 'node:child_process';
import { mkdir, readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, checkSources } from './sources.mjs';
const pins = JSON.parse(await readFile(resolve(root, 'config/aqua-sources.json')));
const swap = pins.sources.find(item => item.name === '@1inch/swap-vm');
await mkdir(resolve(root, 'vendor'), { recursive: true });
try { await access(resolve(root, 'vendor/swap-vm/.git')); }
catch {
  execFileSync('git', ['clone', '--no-checkout', swap.repository, 'vendor/swap-vm'], { cwd: root, stdio: 'inherit' });
  execFileSync('git', ['checkout', '--detach', swap.commit], { cwd: resolve(root, 'vendor/swap-vm'), stdio: 'inherit' });
}
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(root, 'vendor/swap-vm'), encoding: 'utf8' }).trim();
if (revision !== swap.commit) throw new Error('Existing SwapVM checkout differs from the pinned commit; preserve it and review before continuing.');
execFileSync('npm', ['install', '--prefix', 'vendor/framepay-deps', '--save-exact', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund',
  ...pins.sources.filter(item => item.version).map(item => `${item.name}@${item.version}`), `solc@${pins.compiler}`], { cwd: root, stdio: 'inherit' });
await checkSources();
console.log('Official Solidity sources and compiler are ready.');
