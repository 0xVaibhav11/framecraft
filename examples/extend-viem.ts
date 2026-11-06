import { createPublicClient, defineChain, http } from 'viem';
import { frameActions } from '@framepay/sdk';

const gateway = 'http://localhost:14337/rpc';
const chain = defineChain({
  id: 1337, name: 'Local frame devnet',
  nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [gateway] } },
});

// Standard viem actions and FramePay actions remain available on the same client.
export const client = createPublicClient({ chain, transport: http(gateway, { retryCount: 0 }) })
  .extend(frameActions({ profile: 'ethrex-eip8141-tracer' }));
