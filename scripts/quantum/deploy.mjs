import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encodeDeployData } from 'viem';
import { root, checkSources, sourceTree, sha256 } from '../aqua/sources.mjs';
import { openDemo, check } from '../aqua/runtime.mjs';
await checkSources();
const manifest = JSON.parse(await readFile(resolve(root, 'contracts/aqua/artifacts/manifest.json')));
check(manifest.sourceTreeSha256 === await sourceTree('contracts/aqua/src'), 'Run npm run aqua:build first.');
async function artifact(name) {
  const bytes = await readFile(resolve(root, `contracts/aqua/artifacts/${name}.json`));
  check(sha256(bytes) === manifest.artifacts[name], 'Artifact mismatch: ' + name);
  return JSON.parse(bytes);
}
const verifier = await artifact('ZKNOX_ethfalcon'), factory = await artifact('FramePayQuantumFactory');
const demo = await openDemo({ runId: 'quantum-wallet-v1' });
try {
  // Read health before funding or broadcasting; don't accumulate transactions on a stalled chain.
  const latest = await demo.rpc('eth_getBlockByNumber', ['latest', false]);
  check(Date.now() / 1000 - Number(BigInt(latest.timestamp)) < 120, 'Selected chain is stalled. Restore block production before deploying.');
  await demo.fundMaker();
  const v = await demo.rawStep('ETHFalcon', { data: encodeDeployData({ ...verifier, args: [] }) });
  const f = await demo.rawStep('QuantumFactory', { data: encodeDeployData({ ...factory, args: [v.address] }) });
  const record = { genesisHash: demo.state.genesisHash, factory: f.address, factoryCodeHash: f.codeHash, verifier: v.address, verifierCodeHash: v.codeHash,
    factoryTransaction: f.hash, verifierTransaction: v.hash, sourceSha256: manifest.sourceTreeSha256, algorithm: 'ETHFalcon-512 Keccak' };
  await writeFile(resolve(root, 'config/quantum.json'), JSON.stringify({ ...JSON.parse(await readFile(resolve(root, 'config/quantum.json'))), [demo.state.network]: record }, null, 2) + '\n');
  demo.state.status = 'verified'; demo.state.quantum = record; await demo.save();
  console.log(JSON.stringify(record, null, 2));
} finally { try { await demo.evidence(); } finally { await demo.release(); } }
