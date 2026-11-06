import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = await readFile(resolve(root, 'contracts/src/FramePayPaymaster.sol'), 'utf8');
const require = createRequire(import.meta.url);
const library = dirname(require.resolve('@forshtat/hegota-support/package.json'));
const helpers = await readFile(resolve(library, 'contracts/generated/HelperCode.sol'), 'utf8');
const helperBytes = [...source.matchAll(/_deploy\(hex"([a-f0-9]+)"\)/g)].map(match => match[1]);
if (helperBytes.length !== 2 || !helperBytes.every(bytes => helpers.includes(`Devnet.ERC8421_WORKSHOP) return hex"${bytes}"`)))
  throw new Error('Paymaster helper bytes differ from the installed public ERC8421_WORKSHOP helper library.');
const solc = process.env.FRAMEPAY_SOLC ?? 'solc';
const version = execFileSync(solc, ['--version'], { encoding: 'utf8' });
if (!version.includes('0.8.33+commit.64118f21')) throw new Error('Build requires solc 0.8.33+commit.64118f21.');
const input = { language: 'Solidity', sources: { 'FramePayPaymaster.sol': { content: source } }, settings: {
  evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 },
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
} };
const output = JSON.parse(execFileSync(solc, ['--standard-json'], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
const errors = output.errors?.filter(error => error.severity === 'error') ?? [];
if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
const contract = output.contracts['FramePayPaymaster.sol'].FramePayPaymaster;
const sha = value => createHash('sha256').update(value).digest('hex');
const artifact = { contractName: 'FramePayPaymaster', compiler: '0.8.33+commit.64118f21', evmVersion: 'cancun', optimizerRuns: 200,
  sourceSha256: sha(source), helperLibrarySha256: sha(helpers), helperPackageVersion: JSON.parse(await readFile(resolve(library, 'package.json'))).version,
  abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
await mkdir(resolve(root, 'contracts/artifacts'), { recursive: true });
await writeFile(resolve(root, 'contracts/artifacts/FramePayPaymaster.json'), JSON.stringify(artifact, null, 2) + '\n');
console.log(`Built FramePayPaymaster with ${artifact.compiler}; verified both upstream helper bytecodes.`);
