import { unlockQuantumPrivacy, type QuantumCredential } from '@framepay/sdk';
import type { Address, Hex } from 'viem';
import type { BrowserPrivateRequest, BrowserPrivateResult } from '../../../../scripts/private/browser/types';

/** Fresh worker per approval; neither PRF output nor private wallet keys cross the network. */
export async function preparePrivateInBrowser(wallet: QuantumCredential & {address:Address;networkDomain:Hex}, request: BrowserPrivateRequest,
  progress: (stage:string)=>void, signal: AbortSignal): Promise<BrowserPrivateResult> {
  progress('Approve your passkey to unlock private notes…');
  const seed = await unlockQuantumPrivacy(wallet,wallet.networkDomain,wallet.address);
  return new Promise((resolve,reject)=>{
    let worker: Worker | undefined;
    const stop = () => {clearTimeout(timer);worker?.terminate();signal.removeEventListener('abort',cancel);if(seed.byteLength)new Uint8Array(seed).fill(0);};
    const cancel = () => {stop();reject(new Error('Private preparation cancelled. No transaction was sent.'));};
    const timer = setTimeout(()=>{stop();reject(new Error('Private proof timed out. No transaction was sent.'));},240000);
    signal.addEventListener('abort',cancel,{once:true});
    if(signal.aborted){cancel();return;}
    try {
      worker = new Worker('/privacy/worker.mjs',{type:'module'});
      worker.onmessage = event=>{
        if(event.data.stage){progress(event.data.stage);return;}
        stop();
        event.data.error?reject(new Error(event.data.error)):resolve(event.data.result);
      };
      worker.onerror = ()=>{stop();reject(new Error('Private browser worker unavailable. Run bun run private:browser:build.'));};
      worker.postMessage({seed,owner:wallet.address,request},[seed]);
    } catch(error){stop();reject(error);}
  });
}
