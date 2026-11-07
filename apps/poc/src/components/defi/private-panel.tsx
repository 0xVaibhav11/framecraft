"use client";
import { useEffect, useRef, useState } from 'react';
import { formatUnits, parseAbi, parseUnits, type Address } from 'viem';
import { frameNetworks, type QuantumCredential } from '@framepay/sdk';
import { PrivateBrowserSession } from '@/lib/private-browser';
import type { useDefi } from './use-defi';
import type { BrowserPrivateAction, BrowserPrivateRequest, BrowserPrivateSnapshot, Pocket, Asset } from '../../../../../scripts/private/browser/types';
import config from '../../../../../config/private-wallet.json';
import { Icon } from '../icon';
import { shortAddress } from '@/lib/rpc';
const names: Record<BrowserPrivateAction,string> = {scan:'Unlock balances',shield:'Shield',transfer:'Private transfer','add-inventory':'Add inventory',swap:'Private swap','remove-inventory':'Remove inventory',unshield:'Unshield'};
const operations: BrowserPrivateAction[] = ['shield','transfer','add-inventory','swap','remove-inventory','unshield'];
const pockets: Record<Pocket,string> = {maker:'Your wallet',taker:'Your trading pocket',inventory:'Your inventory'};
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
export function PrivatePanel({app,onInspect,onRunning}: {app:ReturnType<typeof useDefi>;onInspect:(hash:string)=>void;onRunning:(running:boolean)=>void}) {
  const [snapshot,setSnapshot] = useState<BrowserPrivateSnapshot|null>(null);
  const [action,setAction] = useState<BrowserPrivateAction>('shield');
  const [wallet,setWallet] = useState<Pocket>('maker');
  const [swapWallet,setSwapWallet] = useState<'maker'|'taker'>('maker');
  const [receiver,setReceiver] = useState<Pocket>('taker');
  const [external,setExternal] = useState(false);
  const [privateRecipient,setPrivateRecipient] = useState('');
  const [token,setToken] = useState<Asset>('A');
  const [amount,setAmount] = useState('10');
  const [recipient,setRecipient] = useState('');
  const [busy,setBusy] = useState(false);
  const [stage,setStage] = useState('Unlock with your passkey to scan your private balances.');
  const [error,setError] = useState('');
  const [review,setReview] = useState<BrowserPrivateRequest|null>(null);
  const [publicBalances,setPublicBalances] = useState({A:'0',B:'0'});
  const [stale,setStale] = useState(false);
  const [viewActive,setViewActive] = useState(false);
  const session = useRef<PrivateBrowserSession|null>(null);
  const controller = useRef<AbortController|null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const owner = app.wallet?.address;
  useEffect(()=>{onRunning(busy);},[busy,onRunning]);
  useEffect(()=>{
    const current=new PrivateBrowserSession(setViewActive);session.current=current;
    const lock=()=>{controller.current?.abort();current.lock();};
    window.addEventListener('pagehide',lock);
    return ()=>{window.removeEventListener('pagehide',lock);lock();if(session.current===current)session.current=null;};
  },[owner,app.network.id]);
  useEffect(()=>{setSnapshot(null);setStale(false);},[owner]);
  useEffect(()=>{if(review)dialog.current?.showModal();},[review]);
  useEffect(()=>{
    let active=true;
    if(owner && app.network.id==='devnet') void Promise.all((['A','B'] as const).map(async asset=>formatUnits(await app.publicClient.readContract({address:(asset==='A'?config.contracts.tokenA:config.contracts.tokenB) as Address,abi:erc20,functionName:'balanceOf',args:[owner]}),18))).then(([A,B])=>{if(active)setPublicBalances({A,B});}).catch(()=>{});
    return ()=>{active=false;};
  },[owner,app.network.id,app.publicClient,app.refreshVersion]);
  useEffect(()=>{
    let active=true;
    if(session.current?.active) void session.current.refresh().then(value=>{if(active){setSnapshot(value);setStale(false);}}).catch(()=>{if(active)setStale(true);});
    else if(snapshot)setStale(true);
    return ()=>{active=false;};
  },[app.refreshVersion]); // This path only uses viewing keys; it can never prompt or sign.
  function lockBalances(){controller.current?.abort();session.current?.lock();setSnapshot(null);setStale(false);setStage('Private balances locked. Unlock again when needed.');}
  async function refreshBalances(){
    if(!session.current?.active){await prepare({action:'scan',wallet,receiver,token});return;}
    setBusy(true);setError('');setStage('Refreshing private balances without another passkey prompt…');
    try{setSnapshot(await session.current.refresh());setStale(false);setStage('Balances refreshed. View-only session active; every spend still needs approval.');}
    catch(cause){setError(cause instanceof Error?cause.message:'Balance refresh failed.');}
    finally{setBusy(false);}
  }
  const disabled=busy||app.locked||!app.ready;
  const quantum=!!app.wallet?.falconPublicKey;
  const spending=action==='add-inventory'?'maker':action==='remove-inventory'?'inventory':action==='swap'?swapWallet:wallet;
  const limit=action==='shield'?undefined:snapshot?.spendable[spending][action==='swap'?'B':token];
  let output='';
  try {if(action==='swap' && snapshot){const input=parseUnits(amount,18),a=parseUnits(snapshot.balances.inventory.A,18),b=parseUnits(snapshot.balances.inventory.B,18);if(input>0n && a>0n && b>0n)output=formatUnits(input*a/(b+input),18);}}catch{}
  async function prepare(input:BrowserPrivateRequest) {
    if(disabled||!app.wallet?.falconPublicKey||!app.walletDeployed)return;
    setBusy(true);setError('');app.setError('');app.setNotice('');setReview(null);
    const abort=new AbortController();controller.current=abort;
    try {
      if(!session.current)throw new Error('Private session is not ready.');
      const result=await session.current.execute(app.wallet as QuantumCredential & {address:Address;networkDomain:`0x${string}`},input,setStage,abort.signal);
      if(abort.signal.aborted)return;
      setSnapshot(result.snapshot);setStale(false);
      if(input.action==='scan'){setStage('Balances unlocked for five minutes. Spending keys were cleared.');return;}
      setStage('Submitting the batch authorized by your passkey…');
      await app.submitPrivateOperation(result,`Private · ${names[input.action]}`,abort.signal);
      if(session.current.active){setSnapshot(await session.current.refresh());setStale(false);}
      setStage('Transaction confirmed. Balances refreshed without another passkey prompt.');
    } catch(cause){setError(abort.signal.aborted?'Private action cancelled. Inspect any saved hash before retrying.':cause instanceof Error?cause.message:'Private action failed.');}
    finally {setBusy(false);}
  }
  function reviewAction(){
    setError('');
    if(!snapshot&&action!=='shield'){setError('Unlock balances once to load your private notes.');return;}
    if(!/^(?:0|[1-9]\d{0,4})(?:\.\d{1,18})?$/.test(amount)||Number(amount)<=0||Number(amount)>10000){setError('Enter an amount greater than zero and no more than 10,000.');return;}
    if(limit!==undefined&&parseUnits(limit,18)===0n){setError(`${pockets[spending]} has no spendable FP${action==='swap'?'B':token}. ${action==='swap'?'Choose a funded pocket under Pay from, or shield FPB to this pocket.':'Shield tokens or transfer private tokens into this pocket first.'}`);return;}
    if(limit!==undefined&&parseUnits(amount,18)>parseUnits(limit,18)){setError(`${pockets[spending]} can spend at most ${limit} FP${action==='swap'?'B':token} from one note. Reduce the amount or use separate transfers.`);return;}
    if(action==='shield'&&parseUnits(amount,18)>parseUnits(publicBalances[token],18)){setError('Your smart wallet needs enough public tokens before shielding.');return;}
    if(action==='swap'&&(!output||Number(output)<=0)){setError('Add both tokens to your inventory before swapping.');return;}
    if(action==='transfer'&&external&&!/^0zk[0-9a-z]{50,126}$/.test(privateRecipient)){setError('Enter a RAILGUN private address beginning with 0zk.');return;}
    if(action==='transfer'&&!external&&wallet===receiver){setError('Choose another pocket or an external private recipient.');return;}
    const destination=recipient||owner||'';
    if(action==='unshield'&&(!/^0x[0-9a-fA-F]{40}$/.test(destination)||/^0x0{40}$/.test(destination))){setError('Enter a nonzero public recipient.');return;}
    if(action==='swap'&&snapshot?.spendable.inventory.A&&parseUnits(output,18)>parseUnits(snapshot.spendable.inventory.A,18)){setError('The quoted output exceeds the largest FPA note in your inventory. Reduce the swap amount.');return;}
    setReview({action,wallet:action==='swap'?swapWallet:wallet,receiver,token,amount,...(action==='swap'?{expectedOutput:output}:{}),...(action==='unshield'?{recipient:destination}:{}),...(action==='transfer'&&external?{privateRecipient}:{})});
  }
  if(app.network.id!=='devnet')return <section className="privacy-panel"><p className="defi-banner">Select {frameNetworks.devnet.name} to use your private wallet.</p></section>;
  if(!quantum||!app.walletDeployed)return <section className="privacy-panel"><article className="defi-card"><h2>Your private wallet starts with your passkey</h2><p>Use a PRF-capable passkey to derive your private wallet keys in the browser. Your ETHFalcon smart wallet authorizes every submitted batch.</p><button className="defi-primary" disabled={disabled} onClick={()=>void app.task(quantum?app.deployWallet:app.createPasskey)}>{quantum?'Deploy your quantum wallet':'Create a passkey wallet'}</button><p className="defi-small">Already have a wallet? Import its public metadata from the Swap page, then return here. The original passkey is still required.</p></article></section>;
  return <section className="privacy-panel" aria-label="Private payments">
    <div className="privacy-notice"><Icon name="info" size={18}/><p><strong>Your passkey controls these private notes.</strong> Keys and proofs stay in a temporary browser worker. One passkey approval proves, signs and submits the reviewed action. A five-minute view-only session refreshes balances without spending authority. RAILGUN proofs remain classical cryptography. Your outer smart-wallet address, shielding, unshielding and timing are public.</p></div>
    {error&&<p className="defi-banner error" role="alert">{error}</p>}
    <div className="privacy-status"><span role="status">{stage}</span><button className="defi-secondary" disabled={disabled} onClick={()=>void refreshBalances()}>{viewActive?'Refresh balances':'Unlock balances'}</button>{viewActive&&<button className="defi-text-button" disabled={busy} onClick={lockBalances}>Lock balances</button>}</div>
    {busy&&!app.pending&&<button className="defi-text-button" onClick={()=>controller.current?.abort()}>Cancel private action</button>}
    {stale&&<p className="defi-small">Balances below are from your last private scan. Refresh balances to update them; unlock again if the view-only session has expired.</p>}
    {snapshot&&<div className="privacy-balances">{(['maker','taker','inventory'] as Pocket[]).map(name=><article className="defi-card" key={name}><h3>{pockets[name]}</h3><p><strong>{snapshot.balances[name].A}</strong> FPA</p><p><strong>{snapshot.balances[name].B}</strong> FPB</p><details><summary>Receive privately</summary><code className="privacy-address">{snapshot.addresses[name]}</code><button className="defi-text-button" onClick={()=>void navigator.clipboard.writeText(snapshot.addresses[name]).catch(()=>setError('Could not copy the address.'))}>Copy private address</button></details></article>)}</div>}
    <div className="privacy-content"><section className="defi-card">
      <div className="privacy-operations">{operations.map(item=><button key={item} disabled={disabled} className={action===item?'active':''} onClick={()=>{setAction(item);setError('');}}>{names[item]}</button>)}</div>
      <h2>{names[action]}</h2>
      {action==='swap'&&<label className="defi-field"><span>Pay from</span><select aria-label="Pay from" value={swapWallet} disabled={disabled} onChange={e=>{setSwapWallet(e.target.value as 'maker'|'taker');setError('');}}><option value="maker">Your wallet</option><option value="taker">Your trading pocket</option></select></label>}
      {['shield','transfer','unshield'].includes(action)&&<label className="defi-field"><span>{action==='shield'?'Shield to':'From pocket'}</span><select aria-label={action==='shield'?'Shield to':'From pocket'} value={wallet} disabled={disabled} onChange={e=>setWallet(e.target.value as Pocket)}>{Object.entries(pockets).map(([key,name])=><option key={key} value={key}>{name}</option>)}</select></label>}
      {action==='transfer'&&<><label className="defi-field"><span>Recipient</span><select aria-label="Recipient" value={external?'external':receiver} disabled={disabled} onChange={e=>{setExternal(e.target.value==='external');if(e.target.value!=='external')setReceiver(e.target.value as Pocket);}}>{Object.entries(pockets).map(([key,name])=><option key={key} value={key}>{name}</option>)}<option value="external">Another private wallet</option></select></label>{external&&<label className="defi-field"><span>Recipient private address</span><input value={privateRecipient} disabled={disabled} onChange={e=>setPrivateRecipient(e.target.value.trim())} placeholder="0zk…"/></label>}</>}
      {action!=='swap'&&<label className="defi-field"><span>Token</span><select aria-label="Token" value={token} disabled={disabled} onChange={e=>setToken(e.target.value as Asset)}><option value="A">FPA</option><option value="B">FPB</option></select></label>}
      <label className="defi-field"><span>{action==='swap'?'You pay (FPB)':'Amount'}</span><input value={amount} inputMode="decimal" disabled={disabled} onChange={e=>setAmount(e.target.value)}/></label>
      {limit!==undefined&&<p className="defi-small">Single-note spending limit: <strong>{limit} FP{action==='swap'?'B':token}</strong></p>}
      {action==='shield'&&<><p className="defi-small">Public smart-wallet balance: {publicBalances[token]} FP{token}. Shielding deducts a 0.25% pool fee.</p><div className="privacy-faucet"><strong>Test-token faucet</strong><p>Receive 1,000 FPA + 1,000 FPB in your smart wallet. Gas is sponsored. One grant per wallet every 24 hours.</p><button className="defi-secondary" disabled={disabled} onClick={()=>void app.task(app.claimPrivateTokens)}>{app.busy?"Requesting tokens…":"Faucet · Get test tokens"}</button><small>Recipient: {owner}</small></div></>}
      {action==='swap'&&<p className="defi-small">{pockets[swapWallet]} receives <strong>{output||'—'} FPA</strong>. This demo swaps between two pockets you own; it is not an external maker quote.</p>}
      {action==='add-inventory'&&<p className="defi-small">Your wallet → your inventory.</p>}{action==='remove-inventory'&&<p className="defi-small">Your inventory → your wallet.</p>}
      {action==='unshield'&&<label className="defi-field"><span>Public recipient (receives 99.75%)</span><input value={recipient} placeholder={owner} disabled={disabled} onChange={e=>setRecipient(e.target.value)}/></label>}
      <button className="defi-primary" disabled={disabled||(!snapshot&&action!=='shield')} onClick={reviewAction}>Review {names[action].toLowerCase()}</button>
    </section><aside className="defi-card"><h3>How your passkey authorizes this</h3><ol><li>Passkey PRF unlocks separate private-wallet entropy, bound to your smart wallet and chain.</li><li>The operation worker proves and signs only the reviewed amount, recipient and swap quote. It clears spending keys when finished.</li><li>ETHFalcon verifies the complete wallet batch onchain. No second passkey approval is needed for that transaction.</li><li>A sponsored frame transaction executes the batch atomically. View its frames below.</li></ol><p className="defi-small">No private seed, mnemonic or spending key is sent to the server or saved in browser storage. Only viewing material remains for five minutes; it cannot spend. Lock balances or leave this page to clear it. Keep your passkey and public wallet metadata to recover the same notes. Existing disposable demo balances belong to the old demo wallets.</p><details><summary>Contracts</summary>{Object.entries(config.contracts).map(([name,address])=><p className="privacy-contract" key={name}><strong>{name}</strong><code>{address}</code></p>)}</details></aside></div>
    <section className="privacy-history"><h3>Your private transaction activity</h3>{app.activity.filter(item=>item.title.startsWith('Private')).map(item=><article key={item.hash}><div><strong>{item.title}</strong><small>{new Date(item.at).toLocaleString()} · {item.status}</small></div><code>{shortAddress(item.hash)}</code><button className="defi-secondary" onClick={()=>onInspect(item.hash)}>View transaction</button></article>)}</section>
    {review&&<dialog ref={dialog} className="defi-review" aria-labelledby="private-review-title" onCancel={e=>{e.preventDefault();setReview(null);}}><h2 id="private-review-title">{names[review.action]}</h2><p>{review.amount} FP{review.action==='swap'?'B':review.token}</p><p>{review.privateRecipient||review.recipient||(review.action==='swap'?`${pockets[review.wallet]} ↔ your inventory`:review.action==='add-inventory'?'Your wallet → your inventory':review.action==='remove-inventory'?'Your inventory → your wallet':review.action==='shield'?`Smart wallet → ${pockets[review.wallet]}`:`${pockets[review.wallet]} → ${pockets[review.receiver]}`)}</p>{['shield','unshield'].includes(review.action)&&<p>Pool fee: 0.25% of the amount. The recipient receives the remainder.</p>}{review.expectedOutput&&<p>Exact output: {review.expectedOutput} FPA</p>}<p>Confirming approves this exact action for proof generation, signing and submission with one passkey prompt. Gas is sponsored. A changed quote, wallet nonce or expired operation requires a new approval.</p><button className="defi-primary" onClick={()=>void prepare(review)}>Confirm with passkey</button><button className="defi-text-button" onClick={()=>setReview(null)}>Back to editing</button></dialog>}
  </section>;
}
