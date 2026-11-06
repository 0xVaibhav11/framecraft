import type { Address, Hex } from 'viem';
import type { Profile } from '@forshtat/hegota-support/profiles';
import type { Frame, FrameTx, SignatureEntry, RecentRootReference } from '@forshtat/hegota-support/tx';

export type { Frame, FrameTx, SignatureEntry, RecentRootReference };
export type FrameProfileId = 'ethrex-eip8141-tracer';

export interface PrepareFrameParameters {
  sender: Address;
  frames: Frame[];
  maxFeePerGas: bigint;
  maxPriorityFeePerGas?: bigint;
  nonceSeq?: bigint;
  nonceKeys?: bigint[];
  signatures?: SignatureEntry[];
  recentRootReferences?: RecentRootReference[];
}

export interface FrameSigner {
  readonly address: Address;
  sign(parameters: { profile: Profile; transaction: FrameTx }): Promise<FrameTx>;
}

export interface FrameReceipt {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: Hex;
  status: '0x0' | '0x1';
  frameReceipts: { status: '0x0' | '0x1' }[];
}

export interface AdmissionCheck {
  rule: string;
  verdict: 'pass' | 'fail' | 'skipped';
  frameIndex?: number;
}

export interface FrameAdmission {
  hash: Hex;
  outcome: 'accepted' | 'included' | 'rejected' | 'replaced' | 'dropped' | null;
  checks: AdmissionCheck[];
  /** False means no retained admission history, not that the transaction was rejected. */
  available: boolean;
}

export interface WaitForFrameReceiptParameters {
  hash: Hex;
  expectedFrameCount?: number;
  timeoutMs?: number;
  pollingIntervalMs?: number;
  signal?: AbortSignal;
}

export type FrameActions = {
  prepareFrameTransaction(parameters: PrepareFrameParameters): Promise<FrameTx>;
  signFrameTransaction(parameters: { transaction: FrameTx; signer: FrameSigner }): Promise<FrameTx>;
  sendFrameTransaction(parameters: { transaction: FrameTx }): Promise<Hex>;
  getFrameReceipt(parameters: { hash: Hex }): Promise<FrameReceipt | null>;
  waitForFrameReceipt(parameters: WaitForFrameReceiptParameters): Promise<FrameReceipt>;
  getFrameAdmission(parameters: { hash: Hex }): Promise<FrameAdmission>;
};
