import { open, unlink, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Effect } from 'effect';
import { encodeFunctionData, parseAbi, keccak256, type Address, type Hex, type Abi } from 'viem';
import { frameNetworks } from '@framepay/sdk';
import { makeRpcClient, requireDevnetChain, readContract } from '@framepay/privacy';
import { readOptional, saveJson, runtime } from '../files.ts';
import { buildContracts } from '../build.ts';
import { deploy, legacy, type Keys } from '../deploy.ts';
await buildContracts();
const rpc=makeRpcClient(frameNetworks.devnet.rpcUrl,fetch,{allowRemote:true});
await Effect.runPromise(requireDevnetChain(rpc,frameNetworks.devnet.genesisHash));
const lockFile=resolve(runtime,'run.lock'),lock=await open(lockFile,'wx',0o600);
try {
 await lock.writeFile(String(process.pid));
 const keys=await readOptional<Keys>(resolve(runtime,'submission-keys.json'));
 if(!keys)throw new Error('The test-token treasury is unavailable.');
 const config=JSON.parse(await readFile('config/private-wallet.json','utf8'));
 const artifact=JSON.parse(await readFile('contracts/private/out/PrivateDemoFaucet.sol/PrivateDemoFaucet.json','utf8'));
 const journalFile=resolve(runtime,'faucet.json');
 const journal=await readOptional<{address?:Address;genesis:Hex;hashes:Hex[]}>(journalFile)??{genesis:frameNetworks.devnet.genesisHash,hashes:[]};
 if(journal.genesis!==frameNetworks.devnet.genesisHash)throw new Error('Faucet journal genesis mismatch');
 if(!journal.address){const receipt=await deploy(rpc,keys.deployer,{abi:artifact.abi as Abi,bytecode:artifact.bytecode.object,runtimeBytes:0},[config.contracts.tokenA,config.contracts.tokenB]);journal.address=receipt.contractAddress!;journal.hashes.push(receipt.transactionHash);await saveJson(journalFile,journal);}
 const abi=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)']);
 for(const token of [config.contracts.tokenA,config.contracts.tokenB] as Address[]){
  const current=await readContract<bigint>(rpc,token,abi,'balanceOf',[journal.address]);
  if(current<100_000n*10n**18n){const receipt=await legacy(rpc,keys.deployer,encodeFunctionData({abi,functionName:'transfer',args:[journal.address,100_000n*10n**18n-current]}),token);journal.hashes.push(receipt.transactionHash);await saveJson(journalFile,journal);}
 }
 const code=await rpc.request<Hex>('eth_getCode',[journal.address,'latest']);
 if(code==='0x')throw new Error('Faucet code unavailable');
 config.faucet={address:journal.address,codeHash:keccak256(code),grant:'1000',cooldownSeconds:86400};
 await writeFile('config/private-wallet.json',JSON.stringify(config,null,2)+'\n');
 console.log(JSON.stringify({faucet:journal.address,fundedEach:'100000',transactions:journal.hashes}));
} finally {await lock.close();await unlink(lockFile);}
