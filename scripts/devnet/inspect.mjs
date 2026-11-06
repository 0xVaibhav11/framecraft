import { loadConfig, checkPins, createRpc, probeGateway, imageInventory, writeEvidence, safeError } from './runtime.mjs';

const offline = process.argv.includes('--offline');
if (process.argv.slice(2).some((arg) => arg !== '--offline')) throw new Error('Usage: npm run devnet:inspect -- [--offline]');
const cfg = await loadConfig();
const report = {
  schemaVersion: 1, kind: 'environment-inspection', observedAt: new Date().toISOString(),
  offline, config: cfg, nodeVersion: process.version, pins: await checkPins(cfg),
  gateway: { status: 'not-checked' }, runtimeImages: { status: 'not-checked' },
  aqua: { status: 'unverified', reason: 'Official Aqua/SwapVM source, deployment, and settlement are still required.' },
};
if (!offline) {
  try { report.gateway = { status: 'reachable', ...await probeGateway(cfg, createRpc(cfg)) }; }
  catch (error) { report.gateway = { status: 'unreachable-or-incompatible', error: safeError(error) }; }
  report.runtimeImages = imageInventory(cfg);
}
const path = await writeEvidence('environment', report);
console.log(`Evidence: ${path}`);
console.log(`Source pins: ${report.pins.verified ? 'matched' : 'MISMATCH'}`);
console.log(`Gateway: ${report.gateway.status}; Aqua: ${report.aqua.status}`);
if (!report.pins.verified || (!offline && (report.gateway.status !== 'reachable' || !report.runtimeImages.ok))) process.exitCode = 1;
