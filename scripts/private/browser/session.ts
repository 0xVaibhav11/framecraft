import { approveQuantumPrivateIntent, type QuantumCredential } from '@framepay/sdk';
import { keccak256, stringToHex, type Address, type Hex } from 'viem';
import type { BrowserPrivateIntent, BrowserPrivateResult, BrowserPrivateSnapshot } from './types.js';
type Wallet = QuantumCredential & {address:Address;networkDomain:Hex};

/** A worker signs one captured intent, then retains only viewing material for up to five minutes. */
export class PrivateBrowserSession {
  private worker?: Worker;
  private pendingRefresh?: {id:number;resolve:(snapshot:BrowserPrivateSnapshot)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
  private refreshPromise?: Promise<BrowserPrivateSnapshot>;
  private sequence=0;
  private operationCancel?: ()=>void;
  private expiresAt=0;
  constructor(private readonly changed:(active:boolean)=>void, private readonly rpcUrl?:string) {}
  get active(){return !!this.worker && this.expiresAt>Date.now();}
  lock(){
    this.operationCancel?.();this.operationCancel=undefined;
    const previous=this.worker;this.worker=undefined;this.expiresAt=0;
    if(previous){previous.onmessage=()=>previous.terminate();previous.postMessage({type:'lock'});setTimeout(()=>previous.terminate(),150);}
    if(this.pendingRefresh){clearTimeout(this.pendingRefresh.timer);this.pendingRefresh.reject(new Error('Private balances are locked.'));this.pendingRefresh=undefined;}
    this.changed(false);
  }
  async execute(wallet:Wallet,request:BrowserPrivateIntent,progress:(stage:string)=>void,signal:AbortSignal):Promise<BrowserPrivateResult> {
    this.lock();
    const intent=structuredClone(request); // Later edits cannot change the approved operation.
    const intentHash=keccak256(stringToHex(JSON.stringify(intent)));
    progress(intent.action==='scan'?'Approve your passkey to unlock balances…':'Approve your passkey once to prove, sign and send…');
    const seed=await approveQuantumPrivateIntent(wallet,wallet.networkDomain,wallet.address,intentHash,signal);
    if(signal.aborted){new Uint8Array(seed).fill(0);throw new Error('Private action cancelled.');}
    return new Promise((resolve,reject)=>{
      let operation:Worker|undefined;
      const clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);this.operationCancel=undefined;if(seed.byteLength)new Uint8Array(seed).fill(0);};
      const fail=(error:Error)=>{clean();operation?.terminate();if(this.worker===operation)this.worker=undefined;this.expiresAt=0;this.changed(false);reject(error);};
      const cancel=()=>fail(new Error('Private action cancelled. No transaction was sent.'));
      const timer=setTimeout(()=>fail(new Error('Private operation timed out. No transaction was sent.')),intent.action==='frame-batch'?480000:240000);
      this.operationCancel=cancel;signal.addEventListener('abort',cancel,{once:true});
      try {
        operation=new Worker('/privacy/worker.mjs',{type:'module'});this.worker=operation;
        operation.onmessage=event=>{
          if(event.data.stage){progress(event.data.stage);return;}
          if(event.data.error){fail(new Error(event.data.error));return;}
          if(!event.data.result || !event.data.expiresAt){fail(new Error('Private worker returned an invalid result.'));return;}
          clean();this.expiresAt=event.data.expiresAt;
          operation!.onmessage=e=>{
            if(e.data.locked){this.lock();return;}
            const pending=this.pendingRefresh;
            if(!pending||e.data.id!==pending.id)return;
            this.pendingRefresh=undefined;clearTimeout(pending.timer);
            e.data.error?pending.reject(new Error(e.data.error)):pending.resolve(e.data.snapshot);
          };
          operation!.onerror=()=>this.lock();
          this.changed(true);resolve(event.data.result);
        };
        operation.onerror=()=>fail(new Error('Private browser worker unavailable. Run bun run private:browser:build.'));
        operation.postMessage({seed,owner:wallet.address,networkDomain:wallet.networkDomain,publicKey:wallet.falconPublicKey,intentHash,request:intent,rpcUrl:this.rpcUrl},[seed]);
      }catch(error){fail(error instanceof Error?error:new Error('Private worker failed.'));}
    });
  }
  refresh():Promise<BrowserPrivateSnapshot> {
    if(!this.active)return Promise.reject(new Error('Unlock balances with your passkey first.'));
    if(this.refreshPromise)return this.refreshPromise;
    this.refreshPromise=new Promise<BrowserPrivateSnapshot>((resolve,reject)=>{
      const id=++this.sequence;
      const timer=setTimeout(()=>{this.pendingRefresh=undefined;reject(new Error('Balance refresh timed out.'));},60000);
      this.pendingRefresh={id,resolve,reject,timer};this.worker!.postMessage({type:'refresh',id});
    }).finally(()=>{this.refreshPromise=undefined;});
    return this.refreshPromise;
  }
}
