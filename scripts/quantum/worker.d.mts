import type { Hex } from 'viem';
export function operate(seed: Uint8Array, digest?: Uint8Array): Promise<{publicKey:Hex[];salt?:Hex;signature?:Hex[]}>;
