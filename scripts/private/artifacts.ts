import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { check, type CircuitArtifacts } from '@framepay/privacy';
import { local, sha256, sourcePins } from './files.ts';

export async function prepareArtifacts(): Promise<CircuitArtifacts> {
  const pins = await sourcePins();
  const directory = resolve(local, 'circuits/01x02');
  await mkdir(directory, { recursive: true });
  for (const name of ['wasm', 'zkey', 'vkey.json'] as const) {
    const file = resolve(directory, name);
    let data: Buffer | undefined;
    try { data = await readFile(file); } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    if (!data) {
      const path = name === 'wasm' ? 'prover/snarkjs/01x02.wasm.br' : `circuits/01x02/${name === 'zkey' ? 'zkey.br' : name}`;
      for (const gateway of ['https://ipfs-lb.com', 'https://gateway.pinata.cloud']) {
        try {
          const response = await fetch(`${gateway}/ipfs/${pins.circuit.cid}/${path}`, { signal: AbortSignal.timeout(120_000) });
          if (!response.ok) continue;
          const encoded = Buffer.from(await response.arrayBuffer());
          const decoded = name === 'vkey.json' ? encoded : brotliDecompressSync(encoded);
          check(sha256(decoded) === pins.circuit.hashes[name], `Circuit ${name} digest mismatch`);
          data = decoded;
          await writeFile(file, data);
          break;
        } catch { /* Try the second public mirror. Never accept an unverified artifact. */ }
      }
    }
    check(data !== undefined && sha256(data) === pins.circuit.hashes[name], `Missing or corrupt circuit ${name}`);
  }
  return { wasm: await readFile(resolve(directory, 'wasm')), zkey: await readFile(resolve(directory, 'zkey')),
    vkey: JSON.parse(await readFile(resolve(directory, 'vkey.json'), 'utf8')) as object };
}
