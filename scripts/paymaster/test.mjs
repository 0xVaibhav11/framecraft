import { execFileSync } from 'node:child_process';
const compiler = process.env.FRAMEPAY_SOLC ?? execFileSync('which', ['solc'], { encoding: 'utf8' }).trim();
try { execFileSync('forge', ['test', '--root', 'contracts', '--use', compiler, '--offline'], { stdio: 'inherit' }); }
catch (error) { process.exitCode = error.status ?? 1; }
