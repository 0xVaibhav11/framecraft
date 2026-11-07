import { build } from 'esbuild';
import { polyfillNode } from 'esbuild-plugin-polyfill-node';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(resolve(root, 'packages/privacy/package.json'));
const engine = dirname(require.resolve('@railgun-community/engine'));
const polyfillRequire = createRequire(require.resolve('esbuild-plugin-polyfill-node'));
const engineRequire = createRequire(resolve(engine, 'index.js'));
const output = resolve(root, 'apps/poc/public/privacy');
await mkdir(output, { recursive: true });
// Install missing artifacts using the existing pinned-download verifier; no contracts are deployed.
const { prepareArtifacts } = await import('../artifacts.ts');
await prepareArtifacts();
const pins = JSON.parse(await readFile(resolve(root, 'config/private/sources.json'), 'utf8'));
for (const name of ['wasm','zkey','vkey.json']) {
  const source = resolve(root, '.framepay/private/circuits/01x02', name);
  const data = await readFile(source).catch(() => { throw new Error('Run bun run private:setup to install the verified privacy circuits.'); });
  if (createHash('sha256').update(data).digest('hex') !== pins.circuit.hashes[name]) throw new Error(`Invalid ${name} digest`);
  await copyFile(source, resolve(output, name));
}
for (const [pkg, file] of [['@railgun-community/poseidon-hash-wasm', 'poseidon_hash_wasm'], ['@railgun-community/curve25519-scalarmult-wasm', 'curve25519_scalarmult_wasm']]) {
  const pkgRoot = dirname(engineRequire.resolve(`${pkg}/package.json`));
  await copyFile(resolve(pkgRoot, `pkg-esm/${file}_bg.wasm`), resolve(output, `${file}_bg.wasm`));
}
await build({ mainFields: ['browser','module','main'], entryPoints: [resolve(root, 'scripts/private/browser/worker.ts')], outfile: resolve(output,'worker.mjs'), bundle: true, platform:'browser', format:'esm', target:'es2022', minify: true,
  define: { 'process.env.NODE_ENV':'"production"', global:'globalThis' },
  plugins: [{ name:'privacy-browser-engine', setup(build) {
    build.onResolve({filter:/^(node:)?assert$/}, () => ({path:'assert',namespace:'cjs-compat'}));
    build.onLoad({filter:/.*/,namespace:'cjs-compat'}, () => ({contents:`import assert from ${JSON.stringify(resolve(polyfillRequire.resolve('@jspm/core/nodelibs/assert'),'../../browser/assert.js'))}; module.exports = assert;`,loader:'js',resolveDir:root}));
    build.onResolve({filter:/^@railgun-community\/engine$/}, () => ({path:resolve(engine,'index.js')}));
    build.onResolve({filter:/^railgun-internal\//}, args => ({path:resolve(engine,args.path.slice('railgun-internal/'.length))}));
    build.onResolve({filter:/^\.\/engine\.js$/}, args => args.importer.includes('/packages/privacy/src/') ? {path:resolve(root,'scripts/private/browser/engine.mjs')} : undefined);
  }}, polyfillNode({polyfills:{crypto:true, fs:false}})],
});
console.log('Privacy browser worker and verified circuits ready.');
