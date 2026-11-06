/** Named environments, not chain-ID aliases: both networks intentionally use 1337. */
export const frameNetworks = {
  local: { id: 'local', name: 'Local devnet', chainId: 1337, profile: 'ethrex-eip8141-tracer',
    rpcUrl: 'http://127.0.0.1:14337/rpc', explorerUrl: 'http://localhost:5173' },
  public: { id: 'public', name: 'Public alt-mempool devnet', chainId: 1337, profile: 'ethrex-eip8141-tracer',
    rpcUrl: 'https://altmempoolgateway.forshtat.com/rpc', explorerUrl: 'https://explorer.altmempool.wtf' },
} as const;
export type FrameNetworkId = keyof typeof frameNetworks;
