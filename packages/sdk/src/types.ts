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

/** The selected contract must independently approve payment. Selection is not sponsorship approval. */
export type TransferPayment = { type: 'self' } | {
  type: 'paymaster'; address: Address; verificationData?: Hex;
  verificationGas?: { execution: bigint; state: bigint };
};

/** Local draft constraints, not persistent on-chain account permissions or daily quotas. */
export interface TransferRules {
  allowedRecipients: readonly Address[];
  maxValue: bigint;
  maxFeePerGas: bigint;
}

export interface PrepareTransferParameters {
  sender: Address;
  transfer: { to: Address; value: bigint };
  payment: TransferPayment;
  rules: TransferRules;
  maxFeePerGas: bigint;
}

export interface TransferPlan {
  parameters: PrepareFrameParameters;
  summary: {
    sender: Address; recipient: Address; value: bigint; payer: Address;
    paymentType: TransferPayment['type']; frameCount: number; maxFeePerGas: bigint;
    rulesEnforcement: 'local-draft-only'; sponsorship: 'not-requested' | 'unconfirmed';
  };
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
  prepareTransfer(parameters: PrepareTransferParameters): Promise<FrameTx>;
  prepareFrameTransaction(parameters: PrepareFrameParameters): Promise<FrameTx>;
  signFrameTransaction(parameters: { transaction: FrameTx; signer: FrameSigner }): Promise<FrameTx>;
  sendFrameTransaction(parameters: { transaction: FrameTx }): Promise<Hex>;
  getFrameReceipt(parameters: { hash: Hex }): Promise<FrameReceipt | null>;
  waitForFrameReceipt(parameters: WaitForFrameReceiptParameters): Promise<FrameReceipt>;
  getFrameAdmission(parameters: { hash: Hex }): Promise<FrameAdmission>;
};
