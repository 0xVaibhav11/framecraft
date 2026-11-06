// Real browser WebAuthn PRF + compiled ETHFalcon signer; no devnet required.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { root } from '../aqua/sources.mjs';
const output = resolve(root, '.framepay/quantum-browser');
await mkdir(output, { recursive: true });
execFileSync('bun', ['build', '--target=browser', resolve(root, 'packages/sdk/src/quantum.ts'), '--outfile=' + resolve(output, 'sdk.mjs')], { stdio: 'inherit' });
const config = JSON.parse(await readFile(resolve(root, 'config/local-devnet.json')));
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require.resolve('playwright'); }
catch { playwright = resolve(root, config.workshopPath, config.sidecarPath, 'node_modules/playwright/index.mjs'); }
const { chromium } = await import(pathToFileURL(playwright).href);
const server = createServer(async (req, res) => {
  const files = { '/sdk.mjs': resolve(output, 'sdk.mjs'), '/ethfalcon/worker.mjs': resolve(root, 'apps/web/public/ethfalcon/worker.mjs'), '/ethfalcon/falcon.mjs': resolve(root, 'apps/web/public/ethfalcon/falcon.mjs') };
  try {
    if (files[req.url]) { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(files[req.url])); }
    else if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>FramePay quantum test</title><p>Disposable virtual passkey test</p>'); }
    else { res.writeHead(404); res.end(); }
  } catch { res.writeHead(500); res.end('Build the signer first.'); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FRAMEPAY_BROWSER_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const options = { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true };
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options });
  await page.goto(`http://localhost:${server.address().port}`);
  const credential = await page.evaluate(async () => {
    const sdk = await import('/sdk.mjs');
    const credential = await sdk.registerQuantumPasskey();
    localStorage.setItem('public-wallet', JSON.stringify(credential));
    return credential;
  });
  console.log('PRF-capable browser credential generated its Falcon public key.');
  const digest = '0x' + '11'.repeat(32);
  const sign = () => page.evaluate(async digest => {
    const sdk = await import('/sdk.mjs');
    const proof = await sdk.signWithQuantumPasskey(JSON.parse(localStorage.getItem('public-wallet')), digest);
    return { ...proof, falconSignature: proof.falconSignature.map(String) };
  }, digest);
  const first = await sign();
  await page.reload();
  const second = await sign();
  assert.deepEqual(Object.keys(first).sort(), ['falconSalt', 'falconSignature']);
  assert.notEqual(first.falconSalt, second.falconSalt, 'Signing entropy must not reset on reload');
  assert.equal(first.falconSignature.length, 32);
  console.log('Reload regenerated the same owner; fresh Falcon signatures contain no WebAuthn proof.');
  const mismatch = await page.evaluate(async digest => {
    const sdk = await import('/sdk.mjs');
    const wrong = JSON.parse(localStorage.getItem('public-wallet'));
    wrong.falconPublicKey[0] = '0x' + '0001'.repeat(16);
    try { await sdk.signWithQuantumPasskey(wrong, digest); return false; }
    catch (error) { return error.message.includes('differs from this wallet'); }
  }, digest);
  assert.equal(mismatch, true);
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { ...options, hasPrf: false } });
  assert.equal(await page.evaluate(async () => {
    try { await (await import('/sdk.mjs')).registerQuantumPasskey(); return false; }
    catch (error) { return error.message.includes('does not support PRF'); }
  }), true);
  const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.deepEqual(Object.keys(stored.local), ['public-wallet']); assert.deepEqual(stored.session, {});
  assert.deepEqual(JSON.parse(stored.local['public-wallet']), credential);
  await writeFile(resolve(output, 'evidence.json'), JSON.stringify({ observedAt: new Date().toISOString(), authenticator: 'Chrome virtual CTAP2.1 PRF', credential, digest, proof: first,
    checks: ['deterministic PRF owner after reload', 'fresh secure signing entropy', 'Falcon-only proof', 'wrong owner rejected', 'PRF unsupported rejected', 'public metadata only'] }, null, 2) + '\n');
  console.log('Wrong owner and unsupported PRF rejected. Only public metadata persisted.');
  console.log('Public evidence: ' + resolve(output, 'evidence.json'));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
