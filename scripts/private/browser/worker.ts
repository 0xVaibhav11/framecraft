import { Mnemonic } from '@railgun-community/engine';
import { decodeAddress } from './engine.mjs';
import { Effect } from 'effect';
import { parseUnits, keccak256, bytesToHex, hexToBytes, stringToHex, encodeFunctionData, parseAbi, isAddress, type Address, type Hex } from 'viem';
import { makeWallet, scan, balance, select, outputs, shieldRequest } from '../../../packages/privacy/src/wallet.js';
import { PrivateTree } from '../../../packages/privacy/src/tree.js';
import { makeRpcClient, requireDevnetChain, readContract } from '../../../packages/privacy/src/rpc.js';
import { PrivateProver, PrivateProverLive } from '../../../packages/privacy/src/prover.js';
import { preparePrivateTransfer } from '../../../packages/privacy/src/payments.js';
import { preparePrivateSwap, quoteExactIn } from '../../../packages/privacy/src/settlement.js';
import { railgunInterface } from '../../../packages/privacy/src/abi.js';
import { operate } from '../../quantum/worker.mjs';
import { falconKeyHash, quantumChallenge, quantumWalletAbi, validateFalconKey } from '../../../packages/sdk/src/quantum.js';
import { makeViewWallet } from '../../../packages/privacy/src/view-wallet.js';
import { snapshotOf, startViewSession } from './view-session.ts';
import type { PrivateWallet, CircuitArtifacts } from '../../../packages/privacy/src/domain.js';
import config from '../../../config/private-wallet.json' with {type:'json'};
import pins from '../../../config/private/sources.json' with {type:'json'};
import type { Pocket, BrowserPrivateRequest, BrowserPrivateResult, BrowserPrivateSnapshot } from './types.ts';
const pockets: Pocket[] = ['maker','taker','inventory'];
const tokens = {A:config.contracts.tokenA as Address,B:config.contracts.tokenB as Address};
const pool = config.contracts.pool as Address;
const tokenAbi = parseAbi(['function approve(address,uint256) returns (bool)']);
async function artifacts(): Promise<CircuitArtifacts> {
  const files = await Promise.all((['wasm','zkey','vkey.json'] as const).map(async name => {
    const response = await fetch(`/privacy/${name}`);
    if (!response.ok) throw new Error('Artifacts unavailable');
    const data = await response.arrayBuffer();
    if (bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).slice(2) !== pins.circuit.hashes[name]) throw new Error('Artifact digest mismatch');
    return new Uint8Array(data);
  }));
  return {wasm:files[0],zkey:files[1],vkey:JSON.parse(new TextDecoder().decode(files[2]))};
}
let started = false;
self.onmessage = async (event: MessageEvent<{seed:ArrayBuffer; owner:Address; networkDomain:Hex; publicKey:Hex[]; intentHash:Hex; request:BrowserPrivateRequest}>) => {
  if (started) return; started = true;
  let stage = 'unlock';
  let response: {result?:BrowserPrivateResult;error?:string} = {};
  const {seed,owner,networkDomain,publicKey,intentHash,request} = event.data;
  let tree: PrivateTree | undefined;
  let views: Record<Pocket,ReturnType<typeof makeViewWallet>> | undefined;
  let privacySeed: ArrayBuffer | undefined;
  const wallets = {} as Record<Pocket,PrivateWallet>;
  try {
    if (!(seed instanceof ArrayBuffer) || seed.byteLength !== 32 || !isAddress(owner)) throw new Error('Invalid worker input');
    if (!['scan','shield','transfer','add-inventory','remove-inventory','swap','unshield'].includes(request.action)
      || !pockets.includes(request.wallet) || !pockets.includes(request.receiver) || !['A','B'].includes(request.token)) throw new Error('Invalid action');
    if(networkDomain!==config.genesisHash || keccak256(stringToHex(JSON.stringify(request)))!==intentHash) throw new Error('Private intent changed');
    validateFalconKey(publicKey);
    const rpc = makeRpcClient(`${self.location.origin}/api/rpc?network=devnet`,fetch,{allowRemote:true});
    stage = 'contract verification';
    await Effect.runPromise(requireDevnetChain(rpc,config.genesisHash as Hex));
    await Promise.all(Object.entries(config.contracts).map(async ([name,address])=>{
      const code = await rpc.request<Hex>('eth_getCode',[address,'latest']);
      if (keccak256(code) !== config.codeHashes[name as keyof typeof config.codeHashes]) throw new Error('Contract code mismatch');
    }));
    stage = 'owner verification';
    const derivedOwner=await operate(new Uint8Array(seed).slice());
    const [ownerHash,domain,nonce,block]=await Promise.all([
      readContract<Hex>(rpc,owner,quantumWalletAbi,'falconKeyHash'),
      readContract<Hex>(rpc,owner,quantumWalletAbi,'networkDomain'),
      readContract<bigint>(rpc,owner,quantumWalletAbi,'nonce'),
      rpc.request<{timestamp:Hex}>('eth_getBlockByNumber',['latest',false]),
    ]);
    if(domain!==networkDomain || falconKeyHash(publicKey)!==ownerHash || falconKeyHash(derivedOwner.publicKey)!==ownerHash)throw new Error('Wrong Falcon owner');
    const deadline=Number(BigInt(block.timestamp))+600;
    const hkdfKey=await crypto.subtle.importKey('raw',seed,'HKDF',false,['deriveBits']);
    privacySeed=await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:new Uint8Array(hexToBytes(networkDomain)),info:new TextEncoder().encode(`FramePay.PrivateWallet.v1:${owner.toLowerCase()}`)},hkdfKey,256);
    tree = new PrivateTree(rpc,pool,config.startBlock as Hex);
    stage = 'tree synchronization';
    self.postMessage({stage:'Scanning your encrypted notes…'});
    await tree.sync();
    stage = 'wallet derivation';
    const key = await crypto.subtle.importKey('raw',privacySeed,{name:'HMAC',hash:'SHA-256'},false,['sign']);
    for (const name of pockets) {
      const entropy = new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`FramePay.PrivatePocket.v1:${name}`)));
      try { wallets[name] = await makeWallet(name,tree,Mnemonic.fromEntropy(bytesToHex(entropy).slice(2))); }
      finally { entropy.fill(0); }
      stage = 'note scan';
      await scan(wallets[name],tree);
      stage = 'wallet derivation';
    }
    new Uint8Array(privacySeed).fill(0);
    const result: BrowserPrivateResult = {snapshot:snapshotOf(owner,tree,wallets),calls:[]};
    if (request.action !== 'scan') {
      stage = 'amount and recipient validation';
      if (!request.amount || !/^(?:0|[1-9]\d{0,4})(?:\.\d{1,18})?$/.test(request.amount)) throw new Error('Invalid amount');
      const quantity = parseUnits(request.amount,18), token = tokens[request.token];
      if (quantity<=0n || quantity>parseUnits('10000',18)) throw new Error('Invalid amount');
      const sender = wallets[request.wallet];
      let data: Hex; let target: Address = pool;
      if (request.action === 'shield') {
        data = railgunInterface.encodeFunctionData('shield',[[await shieldRequest(sender,token,quantity)]]) as Hex;
        result.calls.push({to:token,data:encodeFunctionData({abi:tokenAbi,functionName:'approve',args:[pool,quantity]})});
      } else {
        let receiver = wallets[request.receiver];
        if (request.action === 'transfer' && request.privateRecipient) {
          const address = decodeAddress(request.privateRecipient);
          if (address.chain && (address.chain.type !== 0 || address.chain.id !== 1337)) throw new Error('Wrong private recipient chain');
          receiver = {address} as PrivateWallet;
        }
        if (request.action === 'unshield' && (!request.recipient || !isAddress(request.recipient) || /^0x0{40}$/.test(request.recipient))) throw new Error('Invalid recipient');
        stage = 'proof generation';
        self.postMessage({stage:'Generating private proof in your browser…'});
        const prover = PrivateProverLive(await artifacts());
        if (request.action === 'swap') {
          if (request.wallet === 'inventory') throw new Error('Swap payer must differ from inventory');
          const output = quoteExactIn(quantity,balance(wallets.inventory,tokens.A),balance(wallets.inventory,tokens.B));
          if (!request.expectedOutput || output !== parseUnits(request.expectedOutput,18)) throw new Error('Quote changed');
          result.deadline = deadline;
          const proved = await Effect.runPromise(preparePrivateSwap({maker:wallets.inventory,taker:wallets[request.wallet],makerToken:tokens.A,takerToken:tokens.B,
            makerAmount:output,takerAmount:quantity,pool,adapter:config.contracts.swap as Address,tradeId:bytesToHex(crypto.getRandomValues(new Uint8Array(32))),deadline:BigInt(result.deadline)}).pipe(Effect.provide(prover)));
          data=proved.calldata;target=config.contracts.swap as Address;
        } else if (request.action === 'unshield') {
          const note=select(sender,token,quantity),change=outputs(sender,sender,note,quantity)[1];
          const proved=await Effect.runPromise(Effect.gen(function*(){return yield* (yield* PrivateProver).prove(sender,note,[change],{unshield:{to:request.recipient as Address,amount:quantity}});}).pipe(Effect.provide(prover)));
          data=railgunInterface.encodeFunctionData('transact',[[proved.transaction]]) as Hex;
        } else {
          const from=request.action==='add-inventory'?wallets.maker:request.action==='remove-inventory'?wallets.inventory:sender;
          const to=request.action==='add-inventory'?wallets.inventory:request.action==='remove-inventory'?wallets.maker:receiver;
          if (from.address.masterPublicKey===to.address.masterPublicKey) throw new Error('Choose another recipient');
          data=(await Effect.runPromise(preparePrivateTransfer(from,to,token,quantity).pipe(Effect.provide(prover)))).calldata;
        }
      }
      result.calls.push({to:target,data});
      if (request.action==='shield') result.calls.push({to:token,data:encodeFunctionData({abi:tokenAbi,functionName:'approve',args:[pool,0n]})});
    }
    if(request.action!=='scan') {
      stage='batch signing';
      self.postMessage({stage:'Signing the reviewed batch with the same approval…'});
      const calls=result.calls.map(call=>({target:call.to,value:0n,data:call.data}));
      const challenge=quantumChallenge({chainId:1337n,wallet:owner,networkDomain,nonce,deadline:BigInt(deadline),calls});
      const [liveNonce,liveChallenge]=await Promise.all([
        readContract<bigint>(rpc,owner,quantumWalletAbi,'nonce'),
        readContract<Hex>(rpc,owner,quantumWalletAbi,'challenge',[calls,nonce,BigInt(deadline)]),
      ]);
      if(liveNonce!==nonce || liveChallenge!==challenge)throw new Error('Wallet changed while proving');
      const signed=await operate(new Uint8Array(seed),hexToBytes(challenge));
      if(!signed.salt||!signed.signature||falconKeyHash(signed.publicKey)!==ownerHash)throw new Error('Falcon signing failed');
      const proof={falconSalt:signed.salt,falconSignature:signed.signature.map(BigInt)};
      result.deadline=deadline;
      result.authorization={owner,networkDomain,nonce,challenge,proof};
    }
    views=Object.fromEntries(pockets.map(name=>[name,makeViewWallet(wallets[name])])) as Record<Pocket,ReturnType<typeof makeViewWallet>>;
    response = {result};
  } catch (error) {
    // Prover exceptions can contain private inputs; never forward them to UI or logs.
    response = {error:`Private ${stage} failed. Check the gateway, recipient and available single-note balance; no transaction was sent.`};
  } finally {
    if (seed?.byteLength) new Uint8Array(seed).fill(0);
    if (privacySeed?.byteLength) new Uint8Array(privacySeed).fill(0);
    for (const wallet of Object.values(wallets)) {wallet.viewingKeyPair.privateKey.fill(0);(await wallet.getSpendingKeyPair()).privateKey.fill(0);wallet.notes=[];}
    for(const name of pockets)delete wallets[name];
    if(response.result && views && tree){
      const expiresAt=startViewSession(owner,tree,views);
      self.postMessage({...response,expiresAt});
    } else {self.postMessage(response);self.close();}
  }
};
