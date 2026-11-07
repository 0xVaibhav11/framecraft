import type { Address, Hex } from 'viem';
import type { QuantumProof } from '@framepay/sdk';
export type Pocket = 'maker' | 'taker' | 'inventory';
export type Asset = 'A' | 'B';
export type BrowserPrivateAction = 'scan' | 'shield' | 'transfer' | 'add-inventory' | 'swap' | 'remove-inventory' | 'unshield';
export interface BrowserPrivateRequest {
  action: BrowserPrivateAction; wallet: Pocket; receiver: Pocket; token: Asset;
  amount?: string; expectedOutput?: string; recipient?: string; privateRecipient?: string;
}
export interface BrowserPrivateSnapshot {
  owner: Address; root: Hex; addresses: Record<Pocket, string>;
  balances: Record<Pocket, Record<Asset, string>>;
  spendable: Record<Pocket, Record<Asset, string>>;
}
export interface BrowserPrivateResult {
  snapshot: BrowserPrivateSnapshot;
  calls: { to: Address; data: Hex }[];
  deadline?: number;
  authorization?: {owner:Address;networkDomain:Hex;nonce:bigint;challenge:Hex;proof:QuantumProof};
}
