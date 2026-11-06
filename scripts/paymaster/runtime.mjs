import { frameNetworks } from '@framepay/sdk';
export const isHash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
export const isQuantity = value => typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value);
export function networkFor(id) {
  if (!Object.hasOwn(frameNetworks, id)) throw new Error('Select --network local or --network public.');
  return frameNetworks[id];
}
export function createNetworkRpc(network, fetchImpl = fetch) {
  return async (method, params = []) => {
    let response;
    try {
      response = await fetchImpl(network.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000), redirect: 'error' });
    } catch { throw new Error(`${network.name} gateway is unreachable; no automatic retry was made.`); }
    if (!response.ok) throw new Error(`Gateway HTTP ${response.status} during ${method}.`);
    const body = await response.json();
    if (body?.jsonrpc !== '2.0' || body.id !== 1) throw new Error('Invalid gateway response envelope.');
    if (body.error) throw new Error(`Gateway rejected ${method} (RPC ${Number.isSafeInteger(body.error.code) ? body.error.code : 'error'}).`);
    if (!Object.hasOwn(body, 'result')) throw new Error('Missing gateway result.');
    return body.result;
  };
}
export async function identifyNetwork(rpc, network) {
  const id = await rpc('eth_chainId');
  if (!isQuantity(id) || BigInt(id) !== BigInt(network.chainId)) throw new Error('Wrong devnet chain ID.');
  const genesis = await rpc('eth_getBlockByNumber', ['0x0', false]);
  if (!genesis || !isHash(genesis.hash)) throw new Error('Cannot identify the devnet genesis block.');
  return genesis.hash;
}
export async function waitReceipt(rpc, hash, { timeoutMs = 120_000, intervalMs = 2_000 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt) {
      if (receipt.transactionHash?.toLowerCase() !== hash.toLowerCase() || !isHash(receipt.blockHash)
        || !isQuantity(receipt.blockNumber) || !['0x0', '0x1'].includes(receipt.status)) throw new Error('Malformed or mismatched receipt.');
      return receipt;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('Receipt not observed before timeout. Re-run to inspect the saved hash; do not send a replacement blindly.');
}
export function assertDeploymentReceipt(receipt, address) {
  if (receipt.status !== '0x1' || receipt.contractAddress?.toLowerCase() !== address.toLowerCase())
    throw new Error('Deployment reverted or produced a different contract address; no deployment record was published.');
}
