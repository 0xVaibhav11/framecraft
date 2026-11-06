import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { root, checkSources } from './sources.mjs';
await checkSources();
try { execFileSync('forge', ['test', '--offline', '-vv'], { cwd: resolve(root, 'contracts/aqua'), stdio: 'inherit' }); }
catch (error) { process.exitCode = error.status ?? 1; }
