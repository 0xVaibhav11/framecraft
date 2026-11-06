import { Context, Effect, Layer } from 'effect';
import { Interface, type InterfaceAbi } from 'ethers';
import type { Abi, Address, Hex } from 'viem';
import { PrivacyError } from './errors.js';

export interface RpcClient {
  request<T>(method: string, params?: readonly unknown[]): Promise<T>;
}
export class PrivateRpc extends Context.Service<PrivateRpc, RpcClient>()('@framepay/privacy/Rpc') {}

export interface RpcEndpointOptions { readonly allowRemote?: boolean }
export function rpcUrl(value: string, options: RpcEndpointOptions = {}): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
    || (!local && (!options.allowRemote || url.protocol !== 'https:'))) {
    throw new PrivacyError({ operation: 'config', message: 'Use localhost or an explicitly selected HTTPS frame gateway without URL credentials' });
  }
  return url.toString();
}
export const localRpcUrl = (value: string): string => rpcUrl(value);

export function makeRpcClient(url: string, fetcher: typeof fetch = fetch, options: RpcEndpointOptions = {}): RpcClient {
  rpcUrl(url, options);
  let nextId = 0;
  return {
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      const id = ++nextId;
      let response: Response;
      try {
        response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(60_000), redirect: 'error' });
      } catch {
        throw new PrivacyError({ operation: method, message: 'Gateway unavailable; inspect any submitted hash before retrying' });
      }
      if (!response.ok) throw new PrivacyError({ operation: method, message: `Gateway HTTP ${response.status}` });
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('id' in body) || body.id !== id
        || !('jsonrpc' in body) || body.jsonrpc !== '2.0') {
        throw new PrivacyError({ operation: method, message: 'Malformed or mismatched RPC response' });
      }
      if ('error' in body) {
        // Error messages may embed transaction data. Expose only the numeric RPC code.
        const error = body.error;
        const code = error && typeof error === 'object' && 'code' in error ? error.code : 'unknown';
        const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '';
        const rpcReason = /MAX_VERIFY_GAS|validation.*gas|verification.*gas.*100000/i.test(message) ? 'validation-gas-limit'
          : /revert/i.test(message) ? 'execution-reverted' : undefined;
        throw new PrivacyError({ operation: method, message: `RPC rejected request (code ${String(code)})`,
          rpcCode: typeof code === 'number' ? code : undefined, rpcReason });
      }
      if (!('result' in body)) throw new PrivacyError({ operation: method, message: 'RPC response has no result' });
      return body.result as T;
    },
  };
}
export const PrivateRpcLive = (url: string, options: RpcEndpointOptions = {}) => Layer.succeed(PrivateRpc, makeRpcClient(url, fetch, options));
export const request = <T>(method: string, params: readonly unknown[] = []) => Effect.gen(function* () {
  const rpc = yield* PrivateRpc;
  return yield* Effect.tryPromise({ try: () => rpc.request<T>(method, params),
    catch: (error) => error instanceof PrivacyError ? error : new PrivacyError({ operation: method, message: 'RPC failed' }) });
});
export async function readContract<T>(rpc: RpcClient, to: Address, abi: InterfaceAbi | Abi, name: string, args: readonly unknown[] = []): Promise<T> {
  const iface = new Interface(typeof abi === 'string' ? abi : JSON.stringify(abi));
  const result = await rpc.request<Hex>('eth_call', [{ to, data: iface.encodeFunctionData(name, args) }, 'latest']);
  const decoded = iface.decodeFunctionResult(name, result);
  return (decoded.length === 1 ? decoded[0] : decoded) as T;
}
export const requireDevnetChain = (rpc: RpcClient, expectedGenesis?: Hex) => Effect.tryPromise({
  try: async () => {
    if (BigInt(await rpc.request<string>('eth_chainId')) !== 1337n) {
      throw new Error('Wrong chain');
    }
    if (expectedGenesis) {
      const genesis = await rpc.request<{ hash: Hex }>('eth_getBlockByNumber', ['0x0', false]);
      if (genesis.hash.toLowerCase() !== expectedGenesis.toLowerCase()) throw new Error('Wrong genesis');
    }
  },
  catch: () => new PrivacyError({ operation: 'chain', message: 'Expected frame devnet chain 1337 and the configured genesis hash' }),
});

/** Compatibility alias for localhost callers. */
export const requireLocalChain = requireDevnetChain;
