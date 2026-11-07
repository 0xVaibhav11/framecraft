// Real Chrome WebAuthn PRF, browser Groth16 proofs, ETHFalcon, and configured devnet frames.
// Uses an isolated disposable virtual authenticator; never imports a user's wallet keys.
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '../files.ts';
const require=createRequire(import.meta.url);
const local=JSON.parse(await(await import('node:fs/promises')).readFile(resolve(root,'config/local-devnet.json'),'utf8'));
let playwright;try{playwright=require.resolve('playwright');}catch{playwright=resolve(root,local.workshopPath,local.sidecarPath,'node_modules/playwright/index.mjs');}
const {chromium}=await import(pathToFileURL(playwright).href);
const browser=await chromium.launch({executablePath:process.env.FRAMEPAY_BROWSER_EXECUTABLE??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const output=resolve(root,'.framepay/private/passkey-check');await mkdir(output,{recursive:true});
const page=await browser.newPage({viewport:{width:1440,height:960}});
await page.addInitScript(()=>{const Original=window.Worker;window.__privacyWorkers=[];window.Worker=class extends Original{constructor(url,options){super(url,options);if(String(url).includes('/privacy/worker.mjs'))window.__privacyWorkers.push(this);}};});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
let submissions=0,assertions=0;
page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/api/')){const body=request.postDataJSON();assert.ok(!JSON.stringify(Object.keys(body??{})).match(/seed|mnemonic|privateKey/i));if(body?.method==='eth_sendFrameTransaction')submissions++;assert.ok(!request.url().includes('/api/private'),'No server privacy worker');}});
try{
 const cdp=await page.context().newCDPSession(page);await cdp.send('WebAuthn.enable');
 const {authenticatorId}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',hasPrf:true,transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
 cdp.on('WebAuthn.credentialAsserted',()=>assertions++);
 await page.goto(new URL('/app',process.env.FRAMEPAY_APP_URL??'http://localhost:3000').href);
 await page.locator('.network-badge.online').waitFor({timeout:60000});
 await page.getByRole('button',{name:'Privacy',exact:true}).click();
 const create=page.getByRole('button',{name:'Create a passkey wallet',exact:true});await create.waitFor();await create.click();
 await page.getByRole('button',{name:'Deploy your quantum wallet',exact:true}).waitFor({timeout:60000});
 await page.getByRole('button',{name:'Deploy your quantum wallet',exact:true}).click();
 await page.getByRole('button',{name:'Confirm & send',exact:true}).click();
 await page.getByText('Deploy passkey wallet confirmed. All frames succeeded.',{exact:true}).waitFor({timeout:150000});
 console.log('Passkey smart wallet deployed.');
 const beforeFaucet=assertions;
 await page.getByRole('button',{name:'Faucet · Get test tokens',exact:true}).click();
 await page.getByText('Faucet confirmed: 1,000 FPA and 1,000 FPB sent to your smart wallet.',{exact:true}).waitFor({timeout:150000});
 await page.getByText(/Public smart-wallet balance: 1000 FPA/).waitFor();
 assert.equal(assertions,beforeFaucet,'Public faucet does not request private keys');console.log('One-click sponsored faucet delivered both tokens to the smart wallet.');
 await page.getByRole('button',{name:'Unlock balances',exact:true}).click();
 await page.getByText('Balances unlocked for five minutes. Spending keys were cleared.',{exact:true}).waitFor({timeout:150000});
 const addresses=await page.locator('.privacy-address').allTextContents();assert.equal(addresses.length,3);
 async function action(name,amount,configure){
  await page.locator('.privacy-operations').getByRole('button',{name,exact:true}).click();if(configure)await configure();
  await page.getByLabel(name==='Private swap'?'You pay (FPB)':'Amount',{exact:true}).fill(amount);
  const count=assertions, sent=submissions;
  await page.getByRole('button',{name:`Review ${name.toLowerCase()}`,exact:true}).click();
  await page.getByRole('button',{name:'Confirm with passkey',exact:true}).click();
  await page.getByText(`Private · ${name} confirmed. All frames succeeded.`,{exact:true}).waitFor({timeout:300000});
  await page.getByText('Transaction confirmed. Balances refreshed without another passkey prompt.',{exact:true}).waitFor({timeout:90000});
  assert.equal(assertions,count+1,'Exactly one passkey approval per private transaction');
  assert.equal(submissions,sent+1,'One transaction per approved intent');
  await page.getByRole('button',{name:'Refresh balances',exact:true}).click();
  await page.getByText('Balances refreshed. View-only session active; every spend still needs approval.',{exact:true}).waitFor({timeout:90000});
  assert.equal(assertions,count+1,'Balance refresh must not prompt again');
  console.log(`${name} confirmed with exactly one passkey approval; balance refresh needed none.`);
 }
 if(process.argv.includes('--swap-wallet')) {
  await action('Shield','2',async()=>{await page.getByLabel('Shield to',{exact:true}).selectOption('inventory');});
  await action('Shield','7',async()=>{await page.getByLabel('Token',{exact:true}).selectOption('B');});
  await action('Shield','2',async()=>{await page.getByLabel('Shield to',{exact:true}).selectOption('maker');});
  await page.locator('.privacy-operations').getByRole('button',{name:'Private swap',exact:true}).click();
  await page.getByLabel('Pay from',{exact:true}).selectOption('taker');
  await page.getByLabel('You pay (FPB)',{exact:true}).fill('1');
  const beforeEmpty=assertions;
  await page.getByRole('button',{name:'Review private swap',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Your trading pocket has no spendable FPB'}).waitFor();
  assert.equal(assertions,beforeEmpty);
  await page.getByLabel('Pay from',{exact:true}).selectOption('maker');
  await action('Private swap','1');
  const payerBalances=await page.locator('.privacy-balances article').nth(0).locator('p strong').allTextContents();
  assert.ok(Number(payerBalances[0])>0,'Swap output returns to selected payer');
  assert.equal(payerBalances[1],'0.995','Selected wallet pays one FPB');
  assert.deepEqual(await page.locator('.privacy-balances article').nth(1).locator('p strong').allTextContents(),['0','0'],'Trading pocket stays empty');
 } else {
 await action('Shield','100');
 await action('Private transfer','10',async()=>{await page.getByLabel('From pocket',{exact:true}).selectOption('maker');await page.getByLabel('Recipient',{exact:true}).selectOption('taker');});
 await action('Unshield','5',async()=>{await page.getByLabel('From pocket',{exact:true}).selectOption('taker');});
 await action('Add inventory','20');
 await action('Remove inventory','5');
 await action('Shield','100',async()=>{await page.getByLabel('Token',{exact:true}).selectOption('B');await page.getByLabel('Shield to',{exact:true}).selectOption('maker');});
 await action('Add inventory','40');
 await action('Private transfer','10',async()=>{await page.getByLabel('From pocket',{exact:true}).selectOption('maker');await page.getByLabel('Recipient',{exact:true}).selectOption('taker');});
 await action('Private swap','5');
 }
 await page.reload();await page.locator('.network-badge.online').waitFor({timeout:60000});await page.getByRole('button',{name:'Privacy',exact:true}).click();
 await page.getByRole('button',{name:'Unlock balances',exact:true}).click();await page.getByText('Balances unlocked for five minutes. Spending keys were cleared.',{exact:true}).waitFor({timeout:150000});
 assert.deepEqual(await page.locator('.privacy-address').allTextContents(),addresses,'Same passkey recovers private addresses after reload');
 await page.screenshot({path:resolve(output,'privacy.png')});
 await page.locator('.privacy-history').getByRole('button',{name:'View transaction',exact:true}).first().click();await page.locator('.transaction-actions strong').filter({hasText:'Confirmed'}).waitFor({timeout:60000});assert.equal(await page.locator('.transaction-frame').count(),3);await page.screenshot({path:resolve(output,'frames.png')});await page.getByRole('button',{name:'Close transaction info'}).click();
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const publicData=await page.evaluate(()=>{const entry=Object.entries(localStorage).find(([k])=>k.endsWith(':passkey'));const history=Object.entries(localStorage).find(([k])=>k.endsWith(':activity'));return {wallet:JSON.parse(entry[1]),activity:JSON.parse(history[1]),storageKeys:Object.keys(localStorage)};});
 assert.ok(publicData.activity.every(x=>x.status==='confirmed'));assert.ok(!JSON.stringify(publicData).match(/mnemonic|spendingKey|viewingKey|privateKey|"seed"/));
 // A view-only worker must reject attempts to sign or run another private action.
 const beforeWatch=submissions, beforeWatchApproval=assertions;
 const denied=await page.evaluate(()=>new Promise(resolve=>{const worker=window.__privacyWorkers.at(-1);const handler=e=>{if(e.data.id!==9876)return;worker.removeEventListener('message',handler);resolve(e.data.error);};worker.addEventListener('message',handler);worker.postMessage({id:9876,type:'sign',request:{action:'unshield',amount:'1'}});}));
 assert.match(denied,/only refresh balances/);assert.equal(submissions,beforeWatch);assert.equal(assertions,beforeWatchApproval);
 // Explicit locking removes balances; expiry also drops the read-only session without prompting.
 await page.getByRole('button',{name:'Lock balances',exact:true}).click();
 assert.equal(await page.locator('.privacy-balances').count(),0);
 await page.route('**/privacy/worker.mjs',async route=>{
  const response=await route.fetch();
  const timerShim='const originalSetTimeout=self.setTimeout.bind(self);self.setTimeout=(fn,ms,...args)=>originalSetTimeout(fn,ms===300000?1000:ms,...args);\n';
  await route.fulfill({response,body:timerShim+await response.text()});
 },{times:1});
 const beforeExpiry=assertions;
 await page.getByRole('button',{name:'Unlock balances',exact:true}).click();
 await page.getByText('Balances unlocked for five minutes. Spending keys were cleared.',{exact:true}).waitFor({timeout:150000});
 await page.getByRole('button',{name:'Unlock balances',exact:true}).waitFor({timeout:10000});
 assert.equal(await page.getByRole('button',{name:'Lock balances',exact:true}).count(),0);
 assert.equal(assertions,beforeExpiry+1);assert.equal(submissions,beforeWatch);
 // Cancel while the proof's artifact fetch is blocked: no signing result or broadcast may escape.
 let releaseArtifact, artifactStarted;
 const started=new Promise(resolve=>{artifactStarted=resolve;});
 const hold=new Promise(resolve=>{releaseArtifact=resolve;});
 await page.route('**/privacy/zkey',async route=>{artifactStarted();await hold;await route.abort().catch(()=>{});});
 await page.locator('.privacy-operations').getByRole('button',{name:'Private transfer',exact:true}).click();
 await page.getByLabel('Token',{exact:true}).selectOption('B');await page.getByLabel('From pocket',{exact:true}).selectOption('maker');await page.getByLabel('Recipient',{exact:true}).selectOption('taker');
 await page.getByLabel('Amount',{exact:true}).fill('0.1');
 const beforeCancel=submissions;
 await page.getByRole('button',{name:'Review private transfer',exact:true}).click();await page.getByRole('button',{name:'Confirm with passkey',exact:true}).click();
 let artifactTimer;
 try {await Promise.race([started,new Promise((_,reject)=>{artifactTimer=setTimeout(()=>reject(new Error('Proof did not request its artifact before cancellation test timeout')),150000);})]);}
 finally {clearTimeout(artifactTimer);}
 await page.getByRole('button',{name:'Cancel private action',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Private action cancelled'}).waitFor();releaseArtifact();await page.unroute('**/privacy/zkey');assert.equal(submissions,beforeCancel);
 // Denying the next passkey must not produce a new transaction either.
 await page.evaluate(()=>{navigator.credentials.get=async()=>{throw new DOMException('Cancelled','NotAllowedError');};});
 await page.getByRole('button',{name:'Unlock balances',exact:true}).click();await page.getByRole('alert').filter({hasText:'Cancelled'}).waitFor();assert.equal(submissions,beforeCancel);
 assert.deepEqual(errors,[]);
 await writeFile(resolve(output,'verification.json'),JSON.stringify({...publicData,assertions,submissions,checks:['onchain faucet','one passkey approval per transaction','view-only refresh without prompts','read-only worker rejects signing','explicit lock and session expiry','ETHFalcon onchain authorization',process.argv.includes('--swap-wallet')?'selected swap payer and empty-pocket rejection':'all six private actions','deterministic recovery','three successful frames','cancel during proof and deny passkey before broadcast','no private API','mobile layout']},null,2));
 console.log('PASS: selected private action scenario, passkey recovery, cancellation, transaction viewer and mobile layout.');
}catch(error){console.log((await page.locator('body').innerText()).slice(-7000));throw error;}finally{await browser.close();}
