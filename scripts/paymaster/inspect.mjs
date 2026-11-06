import { createFrameClient } from '@framepay/sdk';
import { defineChain, http } from 'viem';
import { networkFor, isHash } from './runtime.mjs';
const [id, hash] = process.argv.slice(2);
if (process.argv.length !== 4 || !isHash(hash)) throw new Error('Usage: npm run transaction:inspect -- local|public 0x<transaction-hash>');
const network = networkFor(id);
const client = createFrameClient({ profile: network.profile,
  chain: defineChain({ id: network.chainId, name: network.name, nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [network.rpcUrl] } } }),
  transport: http(network.rpcUrl, { retryCount: 0, timeout: 10_000 }),
});
const results = await Promise.allSettled([client.getFrameReceipt({ hash }), client.getFrameAdmission({ hash })]);
for (let index = 0; index < results.length; index++) {
  const result = results[index];
  console.log(JSON.stringify({ kind: index === 0 ? 'receipt' : 'admission', network: network.id, hash,
    ...(result.status === 'fulfilled' ? { result: result.value } : { error: result.reason.message }) }, null, 2));
}
if (results.some(result => result.status === 'rejected')) process.exitCode = 1;
