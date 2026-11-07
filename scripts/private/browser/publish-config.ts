import { readFile, writeFile } from 'node:fs/promises';
import { frameNetworks } from '@framepay/sdk';
import { keccak256, type Hex } from 'viem';
import { Effect } from 'effect';
import { makeRpcClient, requireDevnetChain } from '@framepay/privacy';
const infra = JSON.parse(await readFile('.framepay/private/poc/infrastructure.json', 'utf8'));
const network = frameNetworks.devnet;
if (infra.genesis !== network.genesisHash) throw new Error('Private deployment belongs to another chain.');
const rpc = makeRpcClient(network.rpcUrl, fetch, {allowRemote:true});
await Effect.runPromise(requireDevnetChain(rpc, network.genesisHash));
const contracts = Object.fromEntries(['pool','swap','aqua','tokenA','tokenB'].map(name => [name, infra[name]]));
const codeHashes: Record<string, Hex> = {};
for (const [name, address] of Object.entries(contracts)) {
  const code = await rpc.request<Hex>('eth_getCode',[address,'latest']);
  if (code === '0x') throw new Error('Private contract unavailable');
  codeHashes[name] = keccak256(code);
}
const previous = JSON.parse(await readFile('config/private-wallet.json','utf8').catch(()=>'{}'));
const faucet = previous.genesisHash === infra.genesis ? previous.faucet : undefined;
if (faucet && keccak256(await rpc.request<Hex>('eth_getCode',[faucet.address,'latest'])) !== faucet.codeHash) throw new Error('Faucet code mismatch');
await writeFile('config/private-wallet.json', JSON.stringify({network:'devnet',genesisHash:infra.genesis,startBlock:infra.startBlock,contracts,codeHashes,...(faucet?{faucet}:{})},null,2)+'\n');
console.log('Published verified public private-wallet contract configuration.');
