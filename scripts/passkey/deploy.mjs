import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encodeDeployData } from 'viem';
import { root, checkSources, sourceTree, sha256 } from '../aqua/sources.mjs';
import { openDemo, check } from '../aqua/runtime.mjs';
await checkSources();
const manifest = JSON.parse(await readFile(resolve(root, 'contracts/aqua/artifacts/manifest.json')));
check(manifest.sourceTreeSha256 === await sourceTree('contracts/aqua/src'), 'Run npm run aqua:build first.');
const bytes = await readFile(resolve(root, 'contracts/aqua/artifacts/FramePayPasskeyFactory.json'));
check(sha256(bytes) === manifest.artifacts.FramePayPasskeyFactory, 'Factory artifact mismatch.');
const artifact = JSON.parse(bytes);
const demo = await openDemo({ runId: 'passkey-wallet-v1' });
try {
  await demo.fundMaker();
  const step = await demo.rawStep('PasskeyFactory', { data: encodeDeployData({ ...artifact, args: [] }) });
  // Known valid RIP-7212 vector, also used by OpenZeppelin to detect native support.
  const vector = '0x' + ['bb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605023', '5'.padStart(64,'0'), '1'.padStart(64,'0'), 'a71af64de5126a4a4e02b7922d66ce9415ce88a4c9d25514d91082c8725ac957', '5d47723c8fbe580bb369fec9c2665d8e30a435b9932645482e7c9f11e872296b'].join('');
  const result = await demo.rpc('eth_call', [{ to: '0x0000000000000000000000000000000000000100', data: vector }, 'latest']);
  const record = { network: demo.state.network, genesisHash: demo.state.genesisHash, factory: step.address, factoryCodeHash: step.codeHash, transactionHash: step.hash,
    verifier: 'OpenZeppelin WebAuthn/P256 5.6.1', nativeP256: result !== '0x' && BigInt(result) === 1n, sourceSha256: manifest.sourceTreeSha256 };
  await writeFile(resolve(root, 'config/passkeys.json'), JSON.stringify({ ...JSON.parse(await readFile(resolve(root, 'config/passkeys.json'))), [demo.state.network]: record }, null, 2) + '\n');
  demo.state.status = 'verified'; demo.state.passkey = record; await demo.save();
  console.log(JSON.stringify(record, null, 2));
} finally { try { await demo.evidence(); } finally { await demo.release(); } }
