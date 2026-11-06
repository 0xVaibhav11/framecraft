import { createPublicClient, defineChain, http } from 'viem';
import { frameActions, frameNetworks } from '@framepay/sdk';

// Choose public explicitly; never infer the environment from the shared chain ID.
const network = frameNetworks.local; // or frameNetworks.public
const gateway = network.rpcUrl;
const chain = defineChain({
  id: network.chainId, name: network.name,
  nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [gateway] } },
});

// Standard viem actions and FramePay actions remain available on the same client.
export const client = createPublicClient({ chain, transport: http(gateway, { retryCount: 0 }) })
  .extend(frameActions({ profile: 'ethrex-eip8141-tracer' }));
