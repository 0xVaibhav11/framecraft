// Foundry FFI fixture only: PUBLIC TEST SEED. Never imported by the application.
import { encodeAbiParameters, parseAbiParameters, hexToBytes } from 'viem';
import { readFile } from 'node:fs/promises';
import { operate } from '../../apps/poc/public/ethfalcon/worker.mjs';
if (process.argv[2] === 'browser-fixture') {
  const fixture = JSON.parse(await readFile(new URL('../../tests/fixtures/ethfalcon-browser.json', import.meta.url)));
  process.stdout.write(encodeAbiParameters(parseAbiParameters('bytes32, bytes, uint256[], uint256[]'), [fixture.digest, fixture.salt, fixture.signature.map(BigInt), fixture.publicKey.map(BigInt)]));
  process.exit(0);
}
if (!/^[0-9a-f]{64}$/.test(process.argv[2] ?? '')) throw new Error('Expected test digest');
const result = await operate(new Uint8Array(32).fill(42), hexToBytes('0x' + process.argv[2]));
process.stdout.write(encodeAbiParameters(parseAbiParameters('bytes, uint256[], uint256[]'), [result.salt, result.signature.map(BigInt), result.publicKey.map(BigInt)]));
