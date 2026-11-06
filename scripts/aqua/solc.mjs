#!/usr/bin/env node
// Foundry standard-JSON adapter for the pinned solc-js compiler (no compiler downloads).
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from '../../vendor/framepay-deps/node_modules/solc/index.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
if (process.argv.includes('--version')) console.log(`solc, the solidity compiler\nVersion: ${solc.version()}`);
else if (process.argv.includes('--standard-json')) process.stdout.write(solc.compile(readFileSync(0, 'utf8'), {
  import(path) {
    const file = resolve(path);
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) return { error: 'Import outside project root' };
    try { return { contents: readFileSync(file, 'utf8') }; }
    catch { return { error: `Missing import: ${path}` }; }
  },
}));
else throw new Error('Only --version and --standard-json are supported.');
