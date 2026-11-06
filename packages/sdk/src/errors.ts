import type { Hex } from 'viem';

export type FramePayErrorCode = 'CHAIN_MISMATCH' | 'UNSUPPORTED_PROFILE' | 'INVALID_TRANSACTION'
  | 'INVALID_RESPONSE' | 'SIGNER_MUTATION' | 'SIGNING_FAILED' | 'RPC_ERROR' | 'FRAME_REVERTED' | 'RECEIPT_TIMEOUT' | 'ABORTED';
export type FramePayPhase = 'prepare' | 'sign' | 'submit' | 'receipt' | 'admission';

export class FramePayError extends Error {
  override readonly name = 'FramePayError';
  constructor(
    readonly code: FramePayErrorCode,
    message: string,
    readonly context: { phase: FramePayPhase; transactionHash?: Hex; rpcCode?: number; failedFrameIndices?: number[] },
  ) { super(message); }
}

export function requireCondition(condition: unknown, code: FramePayErrorCode, message: string, phase: FramePayPhase): asserts condition {
  if (!condition) throw new FramePayError(code, message, { phase });
}

export function rpcError(error: unknown, phase: FramePayPhase, transactionHash?: Hex) {
  // Extract only a numeric RPC code; viem errors can otherwise contain the full request body.
  let current = error as { code?: unknown; cause?: unknown } | null;
  let rpcCode: number | undefined;
  for (let i = 0; current && i < 8; i++) {
    if (typeof current.code === 'number') rpcCode = current.code;
    current = current.cause as typeof current;
  }
  return new FramePayError('RPC_ERROR', phase === 'submit'
    ? 'Frame submission failed or its response was lost. Inspect the transaction hash before retrying.'
    : `Gateway RPC failed during ${phase}.`, { phase, transactionHash, rpcCode });
}
