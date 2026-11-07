import type { PrivateViewWallet } from '../../../packages/privacy/src/wallet.js';
import { scan, balance } from '../../../packages/privacy/src/wallet.js';
import type { PrivateTree } from '../../../packages/privacy/src/tree.js';
import { formatUnits, type Address, type Hex } from 'viem';
import { encodeAddress } from './engine.mjs';
import type { Pocket, BrowserPrivateSnapshot } from './types.ts';
import config from '../../../config/private-wallet.json' with {type:'json'};
export const VIEW_SESSION_MS = 5 * 60 * 1000;
const pockets: Pocket[] = ['maker','taker','inventory'];
const tokens = {A:config.contracts.tokenA as Address,B:config.contracts.tokenB as Address};
export function snapshotOf(owner:Address, tree:PrivateTree, wallets:Record<Pocket,PrivateViewWallet>):BrowserPrivateSnapshot {
  return {owner,root:tree.getRoot() as Hex,
    addresses:Object.fromEntries(pockets.map(name=>[name,encodeAddress({...wallets[name].address,chain:{type:0,id:1337}})])) as BrowserPrivateSnapshot['addresses'],
    balances:Object.fromEntries(pockets.map(name=>[name,Object.fromEntries(Object.entries(tokens).map(([asset,token])=>[asset,formatUnits(balance(wallets[name],token),18)]))])) as BrowserPrivateSnapshot['balances'],
    spendable:Object.fromEntries(pockets.map(name=>[name,Object.fromEntries(Object.entries(tokens).map(([asset,token])=>[asset,formatUnits(wallets[name].notes.filter(n=>n.note.tokenData.tokenAddress.toLowerCase()===token.toLowerCase()).reduce((largest,n)=>n.note.value>largest?n.note.value:largest,0n),18)]))])) as BrowserPrivateSnapshot['spendable'],
  };
}
/** This handler receives no seed, mnemonic, spending key or signing callback. */
export function startViewSession(owner:Address,tree:PrivateTree,views:Record<Pocket,{wallet:PrivateViewWallet;dispose():void}>) {
  let closed=false, refreshing=false;
  const expiresAt=Date.now()+VIEW_SESSION_MS;
  const close=()=>{if(closed)return;closed=true;clearTimeout(timer);for(const view of Object.values(views))view.dispose();self.postMessage({locked:true});self.close();};
  const timer=setTimeout(close,VIEW_SESSION_MS);
  self.onmessage=async event=>{
    if(closed)return;
    if(Date.now()>=expiresAt){close();return;}
    const {type,id}=event.data??{};
    if(type==='lock'){close();return;}
    if(type!=='refresh'||!Number.isSafeInteger(id)||id<1){self.postMessage({id,error:'This session can only refresh balances. Every spend requires a new passkey approval.'});return;}
    if(refreshing){self.postMessage({id,error:'A balance refresh is already running.'});return;}
    refreshing=true;
    try {
      await tree.sync();
      const wallets=Object.fromEntries(pockets.map(name=>[name,views[name].wallet])) as Record<Pocket,PrivateViewWallet>;
      for(const wallet of Object.values(wallets))await scan(wallet,tree);
      if(!closed)self.postMessage({id,snapshot:snapshotOf(owner,tree,wallets)});
    } catch {if(!closed)self.postMessage({id,error:'Could not refresh private balances. Check the gateway.'});}
    finally{refreshing=false;}
  };
  return expiresAt;
}
