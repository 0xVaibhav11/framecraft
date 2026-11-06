/** Named environments, not chain-ID aliases: these networks intentionally use 1337. */
export const frameNetworks = {
  devnet: { id: 'devnet', name: 'Framecraft devnet', chainId: 1337, profile: 'ethrex-eip8141-tracer',
    rpcUrl: 'https://psi-essential-rebate-wrist.trycloudflare.com/rpc', explorerUrl: null,
    genesisHash: '0xcd2c67c2bd8cb5458eb2d878877668a0b86ed19fed44fbc874f3254106b97b88' },
  local: { id: 'local', name: 'Local devnet', chainId: 1337, profile: 'ethrex-eip8141-tracer',
    rpcUrl: 'http://127.0.0.1:14337/rpc', explorerUrl: 'http://localhost:5173' },
  public: { id: 'public', name: 'Public alt-mempool devnet', chainId: 1337, profile: 'ethrex-eip8141-tracer',
    rpcUrl: 'https://altmempoolgateway.forshtat.com/rpc', explorerUrl: 'https://explorer.altmempool.wtf' },
} as const;
export type FrameNetworkId = keyof typeof frameNetworks;
