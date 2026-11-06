import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, sha256 } from '../aqua/sources.mjs';
const pins = JSON.parse(await readFile(resolve(root, 'config/ethfalcon.json')));
const upstream = resolve(root, 'vendor/ethfalcon');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim();
if (revision !== pins.commit) throw new Error('ETHFalcon checkout differs from its pin.');
const src = resolve(upstream, 'falcon/nistfalcon/src');
const fingerprints = [];
for (const name of (await readdir(src)).filter(n => /\.(c|h)$/.test(n)).sort()) fingerprints.push([name, sha256(await readFile(resolve(src, name)))]);
if (sha256(JSON.stringify(fingerprints)) !== pins.cSourceSha256) throw new Error('ETHFalcon C source changed.');
const output = resolve(root, 'apps/web/public/ethfalcon');
await mkdir(output, { recursive: true });
const emsdk = resolve(root, 'vendor/emsdk/upstream/emscripten/emcc');
const standalone = resolve(root, 'vendor/framepay-emscripten/install/emscripten/emcc');
const compiler = process.env.FRAMEPAY_EMCC ?? (existsSync(emsdk) ? emsdk : existsSync(standalone) ? standalone : 'emcc');
// Support an activated emsdk, a standalone official archive, or an explicit compiler.
const env = { ...process.env };
if (compiler === standalone && !env.EM_CONFIG) env.EM_CONFIG = resolve(root, 'vendor/framepay-emscripten/.emscripten');
const version = execFileSync(compiler, ['--version'], { encoding: 'utf8', env });
if (!version.includes(pins.emscripten)) throw new Error(`Expected Emscripten ${pins.emscripten}.`);
const files = ['codec', 'common', 'fft', 'fpr', 'keygen', 'nist16', 'rng', 'shake', 'sign', 'vrfy', 'keccak_prng', 'keccak256'];
execFileSync(compiler, [...files.map(n => resolve(src, n + '.c')), resolve(root, 'scripts/quantum/random.c'), '-I' + src,
  '-DETHFALCON=1', '-O3', '-sWASM=1', '-sSINGLE_FILE=1', '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sWASM_BIGINT=1',
  '-sALLOW_MEMORY_GROWTH=1', '-sSTACK_SIZE=1048576',
  '-sEXPORTED_FUNCTIONS=["_zknox_crypto_sign_keypair_from_seed","_zknox_crypto_sign","_zknox_crypto_sign_open","_malloc"]',
  '-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]', '-o', resolve(output, 'falcon.mjs')], { stdio: 'inherit', env });
await copyFile(resolve(root, 'scripts/quantum/worker.mjs'), resolve(output, 'worker.mjs'));
await copyFile(resolve(upstream, 'LICENSE.txt'), resolve(output, 'LICENSE.txt'));
await writeFile(resolve(output, 'build.json'), JSON.stringify({ ...pins, moduleSha256: sha256(await readFile(resolve(output, 'falcon.mjs'))) }, null, 2) + '\n');
console.log('Built ETHFalcon Keccak signer with Web Crypto entropy and an isolated worker.');
