import type { Address } from 'viem';
import type { Asset } from '../../../../../scripts/private/browser/types';
import deployment from '../../../../../config/private-wallet.json';

export const privateTokens: Record<Asset, Address> = {
  A: deployment.contracts.tokenA as Address,
  B: deployment.contracts.tokenB as Address,
};
/** Resolve public token references to the worker's configured assets, never arbitrary ERC-20s. */
export function privateAsset(value: unknown): Asset {
  if (typeof value === 'string') {
    const symbol = value.toUpperCase();
    if (symbol === 'A' || symbol === 'FPA') return 'A';
    if (symbol === 'B' || symbol === 'FPB') return 'B';
    for (const asset of ['A', 'B'] as const)
      if (value.toLowerCase() === privateTokens[asset].toLowerCase()) return asset;
  }
  throw new Error('Use FPA/FPB, their configured token addresses, or the A/B aliases. Other tokens are not supported by this private deployment.');
}
