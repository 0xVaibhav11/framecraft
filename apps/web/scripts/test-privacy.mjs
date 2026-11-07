// Resolve EVML from the same pinned source checkout as the browser build.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { local } from './evmcrispr-sources.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = path.join(root, '.framepay/evml-privacy-tests.mjs');
await mkdir(path.dirname(out), { recursive: true });
await build({ entryPoints: [path.join(root, 'tests/evml-privacy.test.ts')], outfile: out, bundle: true,
  platform: 'node', format: 'esm', target: 'node22', packages: 'external', tsconfigRaw: {},
  plugins: [{ name: 'evml-source-aliases', setup(b) {
    b.onResolve({ filter: /^@evmcrispr\// }, args => {
      const alias = local.alias.find(alias => alias.find.test(args.path));
      return alias ? { path: alias.replacement } : undefined;
    });
    b.onResolve({ filter: /^[^./]/ }, args => {
      if (args.path.startsWith('node:')) return { path: args.path, external: true };
      if (args.path === '@framepay/sdk') return { path: path.join(root, 'packages/sdk/dist/index.js'), external: true };
      return { path: createRequire(args.importer).resolve(args.path), external: true };
    });
  } }],
});
try { execFileSync(process.execPath, ['--test', out], { cwd: root, stdio: 'inherit' }); }
finally { await rm(out, { force: true }); }
