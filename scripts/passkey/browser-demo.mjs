import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const root = fileURLToPath(new URL('../../', import.meta.url));
const config = JSON.parse(await readFile(resolve(root, 'config/local-devnet.json')));
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require.resolve('playwright'); }
catch { playwright = resolve(root, config.workshopPath, config.sidecarPath, 'node_modules/playwright/index.mjs'); }
const { chromium } = await import(pathToFileURL(playwright).href);
const output = resolve(root, '.framepay/passkey-browser', String(Date.now()));
await mkdir(output, { recursive: true });
const executablePath = process.env.FRAMEPAY_BROWSER_EXECUTABLE
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
// Uses a disposable virtual authenticator and real configured devnet transactions.
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
 const cdp = await page.context().newCDPSession(page);
 await cdp.send('WebAuthn.enable');
 const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', hasPrf: true, transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
 await page.goto(new URL('/app', process.env.FRAMEPAY_APP_URL ?? 'http://localhost:3000').href);
 const create = page.locator('.defi-wallet-card').getByRole('button', { name:'Create quantum wallet', exact:true });
 await create.waitFor();
 await page.waitForFunction(() => ![...document.querySelectorAll('.defi-wallet-card button')].find(el => el.textContent === 'Create quantum wallet')?.disabled);
 await create.click();
 const deploy = page.getByRole('button', { name:'Deploy wallet', exact:true });
 await deploy.waitFor({timeout:30000});
 console.log('Browser passkey generated; only public metadata stored.');
 await deploy.click();
 await page.getByRole('button', { name:'Confirm & send', exact:true }).click();
 await page.getByText('Deploy passkey wallet confirmed. All frames succeeded.', { exact:true }).waitFor({timeout:130000});
 console.log('Passkey wallet deployed in sponsored frame.');
 await page.getByRole('button', { name:'Get test tokens', exact:true }).click();
 await page.getByRole('button', { name:'Confirm & send', exact:true }).click();
 await page.getByText('Get test tokens confirmed. All frames succeeded.', { exact:true }).waitFor({timeout:130000});
 console.log('Claim verified onchain with ETHFalcon.');
 await page.getByRole('button', { name:'Review swap', exact:true }).click();
 await page.getByRole('button', { name:'Confirm & send', exact:true }).click();
 await page.getByText('Confirm swap confirmed. All frames succeeded.', { exact:true }).waitFor({timeout:130000});
 console.log('Swap from passkey wallet verified.');
 await page.getByRole('navigation', {name:'DeFi app'}).getByRole('button', { name:'Transfer', exact:true }).click();
 await page.getByLabel('Recipient', {exact:false}).fill('0x000000000000000000000000000000000000b0b0');
 await page.getByRole('button', { name:'Review transfer', exact:true }).click();
 await page.getByRole('button', { name:'Confirm & send', exact:true }).click();
 await page.getByText('Confirm transfer confirmed. All frames succeeded.', { exact:true }).waitFor({timeout:130000});
 console.log('Transfer from passkey wallet verified.');
 // Losing the relay key must not lose control of a passkey wallet.
 await page.evaluate(() => { for(const key of Object.keys(sessionStorage)) if(key.endsWith(':key')) sessionStorage.removeItem(key); });
 await page.reload();
 await page.getByText('ETHFalcon · verified onchain', {exact:true}).waitFor({timeout:30000});
 await page.getByRole('navigation', {name:'DeFi app'}).getByRole('button', { name:'Positions', exact:true }).click();
 await page.getByRole('button', {name:'+ Create',exact:true}).click();
 await page.getByLabel('Position name', {exact:true}).fill('Passkey recurring buy');
 await page.getByRole('button', {name:'Review position',exact:true}).click();
 await page.getByRole('button', { name:'Confirm & send', exact:true }).click();
 await page.getByText('Create recurring buy confirmed. All frames succeeded.', {exact:true}).waitFor({timeout:130000});
 const position = page.getByRole('article').filter({hasText:'Passkey recurring buy'});
 await position.getByRole('button', {name:'Cancel position',exact:true}).click();
 await page.getByRole('button', { name:'Confirm & send', exact:true }).click();
 await page.getByText('Cancel recurring buy confirmed. All frames succeeded.', {exact:true}).waitFor({timeout:130000});
 console.log('New relay key submitted passkey-authorized position creation and cancellation.');
 const downloadPromise=page.waitForEvent('download');
 await page.getByRole('button', {name:'Export wallet metadata',exact:true}).click();
 const download=await downloadPromise; await download.saveAs(resolve(output, 'wallet-metadata.json'));
 const metadata=JSON.parse(await (await import('node:fs/promises')).readFile(resolve(output, 'wallet-metadata.json')));
 if(metadata.privateKey || metadata.wallet.privateKey || metadata.type!=='framepay-quantum-v1') throw new Error('Unexpected private export.');
 await page.evaluate(() => { for(const key of Object.keys(localStorage)) if(key.endsWith(':passkey')) localStorage.removeItem(key); });
 await page.reload();
 await page.getByLabel('Wallet or test account export file', {exact:true}).setInputFiles(resolve(output, 'wallet-metadata.json'));
 await page.getByText('ETHFalcon · verified onchain', {exact:true}).waitFor({timeout:30000});
 await page.getByRole('navigation', {name:'DeFi app'}).getByRole('button', { name:'Swap', exact:true }).click();
 await page.waitForTimeout(1000);
 console.log('Public metadata export/import restored the wallet.');
 // Run the deliberately denied verification last so the virtual authenticator's failure state cannot affect recovery checks.
 await page.getByRole('navigation', {name:'DeFi app'}).getByRole('button', { name:'Transfer', exact:true }).click();
 await page.getByLabel('Recipient', {exact:false}).fill('0x000000000000000000000000000000000000b0b0');
 const before = await page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.endsWith(':activity'))[1]).length);
 await cdp.send('WebAuthn.setUserVerified', {authenticatorId, isUserVerified:false});
 await page.getByRole('button', { name:'Review transfer', exact:true }).click();
 await page.getByRole('button', { name:'Confirm & send', exact:true }).click();
 await page.getByRole('dialog').waitFor({state:'hidden',timeout:65000});
 if(await page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.endsWith(':activity'))[1]).length)!==before) throw new Error('Missing UV created a transaction.');
 console.log('Missing user verification blocked before broadcast.');
 const data = await page.evaluate(() => ({wallet: JSON.parse(Object.entries(localStorage).find(([k]) => k.endsWith(':passkey'))[1]), activity: JSON.parse(Object.entries(localStorage).find(([k]) => k.endsWith(':activity'))[1])}));
 await writeFile(resolve(output, 'browser-evidence.json'), JSON.stringify({ observedAt:new Date().toISOString(), authenticator:'Chrome CDP virtual CTAP2.1 with PRF and required user verification', ...data },null,2));
 await page.screenshot({path:resolve(output, 'app.png'),fullPage:true});
 if(errors.length) throw new Error(errors.join('\n'));
 console.log('Reload restored passkey wallet; runtime errors:', errors);
 console.log(`Public browser evidence and screenshot: ${output}`);
} catch(error) {
 console.error(error.message);
 console.log('Alerts:',await page.getByRole('alert').allTextContents());
 console.log('Status:',await page.getByRole('status').allTextContents());
 await page.screenshot({path:resolve(output, 'error.png'),fullPage:true});
 process.exitCode=1;
} finally { await browser.close(); }
