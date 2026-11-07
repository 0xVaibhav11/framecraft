import type { Address, Hex } from 'viem';
import type { QuantumProof } from '@framepay/sdk';
/** A deterministic, locally owned pocket label, not another person's identity. */
export type Pocket = string;
export type Asset = 'A' | 'B';
export type BrowserPrivateAction = 'scan' | 'shield' | 'transfer' | 'add-inventory' | 'swap' | 'remove-inventory' | 'unshield';
export interface BrowserPrivateRequest {
  action: BrowserPrivateAction; wallet: Pocket; receiver: Pocket; token: Asset;
  amount?: string; expectedOutput?: string; recipient?: string; privateRecipient?: string;
  inventory?: Pocket;
  /** Other known local pockets to include in the viewing session. */
  pockets?: Pocket[];
}
export interface BrowserPrivateFrameRequest {
  action: 'frame-batch';
  requests: BrowserPrivateRequest[];
  /** Binds the complete frame plan to the passkey prompt, including public calls and gas/payment choices. */
  frameContext: Hex;
  pockets?: Pocket[];
}
export type BrowserPrivateIntent = BrowserPrivateRequest | BrowserPrivateFrameRequest;
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
  batches?: BrowserPrivateResult[];
  frameContext?: Hex;
}
