import { isAddress, isHex, type Client, type Hex } from 'viem';
import { getProfile } from '@forshtat/hegota-support/profiles';
import { newTx, secp256k1Placeholder, sigHash, txHash } from '@forshtat/hegota-support/tx';
import { toWire } from '@forshtat/hegota-support/rpc';
import type { FrameActions, FrameAdmission, FrameProfileId, FrameReceipt, FrameTx } from './types.js';
import { FramePayError, requireCondition, rpcError, type FramePayPhase } from './errors.js';
import { buildTransferPlan } from './transfer.js';

type Request = (request: { method: string; params?: readonly unknown[] }, options?: { retryCount?: number; dedupe?: boolean }) => Promise<unknown>;
const isHash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const isQuantity = (value: unknown): value is Hex => typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value);

function boundedWait<T>(operation: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, hash: Hex): Promise<T> {
  // This cancels waiting, not the submitted transaction or the underlying read-only transport request.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new FramePayError('RECEIPT_TIMEOUT', 'Inclusion was not observed before timeout; inspect the hash before retrying.', { phase: 'receipt', transactionHash: hash })), timeoutMs);
    const abort = () => finish(new FramePayError('ABORTED', 'Stopped waiting; the transaction may still execute.', { phase: 'receipt', transactionHash: hash }));
    function finish(error?: unknown, value?: T) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    operation.then((value) => finish(undefined, value), (error: unknown) => finish(error));
  });
}

export function frameActions({ profile: profileId }: { profile: FrameProfileId }) {
  requireCondition(profileId === 'ethrex-eip8141-tracer', 'UNSUPPORTED_PROFILE', 'This prototype supports the ethrex-eip8141-tracer profile only.', 'prepare');
  const profile = getProfile(profileId);
  return (client: Client): FrameActions => {
    requireCondition(client.chain && client.chain.id === profile.devnet.chainId, 'CHAIN_MISMATCH', 'Configure the viem client with the profile chain ID (1337).', 'prepare');
    const chainId = client.chain.id;
    const request = client.request as Request;
    async function call(method: string, params: readonly unknown[], phase: FramePayPhase, hash?: Hex) {
      try {
        // Disable viem retries for every request; in particular, never transparently repeat a submission.
        return await request({ method, params }, { retryCount: 0, dedupe: false });
      } catch (error) { throw rpcError(error, phase, hash); }
    }
    async function checkChain(phase: FramePayPhase) {
      const actual = await call('eth_chainId', [], phase);
      requireCondition(isQuantity(actual), 'INVALID_RESPONSE', 'Gateway returned an invalid chain ID.', phase);
      requireCondition(BigInt(actual) === BigInt(chainId), 'CHAIN_MISMATCH', 'Gateway chain differs from the configured frame profile.', phase);
    }
    function validateTx(transaction: FrameTx, phase: FramePayPhase) {
      requireCondition(transaction.chainId === BigInt(chainId), 'CHAIN_MISMATCH', 'Frame transaction chain differs from the client.', phase);
      requireCondition(isAddress(transaction.sender) && transaction.frames.length > 0 && transaction.signatures.length > 0,
        'INVALID_TRANSACTION', 'A frame transaction needs a valid sender, frames, and authorization entries.', phase);
      requireCondition(transaction.nonceSeq >= 0n && transaction.nonceKeys.length > 0 && transaction.nonceKeys.every((key) => key >= 0n),
        'INVALID_TRANSACTION', 'Nonces must be nonnegative and include at least one nonce key.', phase);
      requireCondition(transaction.fees.maxFeePerGas > 0n && transaction.fees.maxPriorityFeePerGas >= 0n
        && transaction.fees.maxPriorityFeePerGas <= transaction.fees.maxFeePerGas,
      'INVALID_TRANSACTION', 'Invalid frame fee bounds.', phase);
      for (const frame of transaction.frames) {
        requireCondition((frame.target === null || isAddress(frame.target)) && isHex(frame.data)
          && frame.value >= 0n && frame.limits.execution > 0n && frame.limits.state >= 0n,
        'INVALID_TRANSACTION', 'Invalid frame target, calldata, value, or gas limits.', phase);
      }
    }
    function parseReceipt(value: unknown, hash: Hex): FrameReceipt | null {
      if (value === null) return null;
      const result = value as Partial<FrameReceipt>;
      requireCondition(result && isHash(result.transactionHash) && result.transactionHash.toLowerCase() === hash.toLowerCase()
        && isHash(result.blockHash) && isQuantity(result.blockNumber)
        && (result.status === '0x0' || result.status === '0x1'),
      'INVALID_RESPONSE', 'Malformed or mismatched frame receipt.', 'receipt');
      requireCondition(Array.isArray(result.frameReceipts) && result.frameReceipts.length > 0
        && result.frameReceipts.every((frame) => frame.status === '0x0' || frame.status === '0x1'),
      'INVALID_RESPONSE', 'Receipt has no valid per-frame results; this may not be a frame transaction.', 'receipt');
      return {
        transactionHash: result.transactionHash, blockHash: result.blockHash, blockNumber: result.blockNumber,
        status: result.status, frameReceipts: result.frameReceipts.map(({ status }) => ({ status })),
      };
    }
    const actions: FrameActions = {
      async prepareTransfer(parameters) {
        const plan = buildTransferPlan({ ...parameters, profile: profileId });
        await checkChain('prepare');
        // This convenience module intentionally supports EOA ETH transfers only.
        // Contract accounts/actions should use the explicit low-level frame API.
        for (const address of new Set([plan.summary.sender, plan.summary.recipient])) {
          const code = await call('eth_getCode', [address, 'latest'], 'prepare');
          requireCondition(code === '0x', 'INVALID_TRANSACTION', 'The transfer module requires a plain EOA sender and recipient.', 'prepare');
        }
        if (plan.summary.paymentType === 'paymaster') {
          const code = await call('eth_getCode', [plan.summary.payer, 'latest'], 'prepare');
          requireCondition(typeof code === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(code),
            'INVALID_TRANSACTION', 'No deployed contract code was found at the selected paymaster.', 'prepare');
        }
        const balance = await call('eth_getBalance', [plan.summary.sender, 'latest'], 'prepare');
        requireCondition(isQuantity(balance), 'INVALID_RESPONSE', 'Gateway returned an invalid sender balance.', 'prepare');
        requireCondition(BigInt(balance) >= plan.summary.value
          && (plan.summary.paymentType === 'paymaster' || BigInt(balance) > plan.summary.value),
          'INVALID_TRANSACTION', 'Sender needs the transfer value and, when self-paying, ETH for gas. Sponsorship covers gas only.', 'prepare');
        // Code presence is not a compatibility, funding, or sponsorship guarantee.
        return actions.prepareFrameTransaction(plan.parameters);
      },
      async prepareFrameTransaction(parameters) {
        // Snapshot before asynchronous RPC calls so caller mutation cannot change the prepared request.
        const p = structuredClone(parameters);
        const keys = p.nonceKeys ?? [0n];
        const ordinaryNonce = keys.length === 1 && keys[0] === 0n;
        requireCondition(p.nonceSeq !== undefined || ordinaryNonce, 'INVALID_TRANSACTION',
          'Provide nonceSeq explicitly for keyed nonces; ordinary account nonce lookup is not valid for nonzero keys.', 'prepare');
        requireCondition(isAddress(p.sender), 'INVALID_TRANSACTION', 'Invalid sender address.', 'prepare');
        await checkChain('prepare');
        let nonceSeq = p.nonceSeq;
        if (nonceSeq === undefined) {
          const nonce = await call('eth_getTransactionCount', [p.sender, 'latest'], 'prepare');
          requireCondition(isQuantity(nonce), 'INVALID_RESPONSE', 'Gateway returned an invalid account nonce.', 'prepare');
          nonceSeq = BigInt(nonce);
        }
        const transaction = newTx({
          chainId, sender: p.sender, frames: p.frames, nonceSeq, nonceKeys: keys,
          signatures: p.signatures ?? [secp256k1Placeholder(profile)],
          fees: { maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas },
        });
        if (p.recentRootReferences) transaction.recentRootReferences = p.recentRootReferences;
        validateTx(transaction, 'prepare');
        return transaction;
      },
      async signFrameTransaction({ transaction, signer }) {
        const snapshot = structuredClone(transaction);
        validateTx(snapshot, 'sign');
        const authorizedHash = sigHash(profile, snapshot);
        let signed: FrameTx;
        try { signed = await signer.sign({ profile, transaction: snapshot }); }
        catch (error) {
          if (error instanceof FramePayError) throw error;
          throw new FramePayError('SIGNING_FAILED', 'Signer failed; its raw error is omitted to protect signing inputs.', { phase: 'sign' });
        }
        validateTx(signed, 'sign');
        requireCondition(sigHash(profile, signed) === authorizedHash, 'SIGNER_MUTATION', 'Signer changed the authorized transaction envelope.', 'sign');
        return structuredClone(signed);
      },
      async sendFrameTransaction({ transaction }) {
        const snapshot = structuredClone(transaction);
        validateTx(snapshot, 'submit');
        requireCondition(snapshot.signatures.every((entry) => entry.scheme !== profile.sigSchemes.SECP256K1
          || /^0x[0-9a-fA-F]{130}$/.test(entry.signature)), 'INVALID_TRANSACTION', 'SECP256K1 authorization is missing a 65-byte signature.', 'submit');
        const hash = txHash(profile, snapshot);
        await checkChain('submit');
        const result = await call('eth_sendFrameTransaction', [toWire(snapshot)], 'submit', hash);
        if (!isHash(result) || result.toLowerCase() !== hash.toLowerCase()) {
          throw new FramePayError('INVALID_RESPONSE', 'Gateway returned a different hash; inspect the expected hash before retrying.', { phase: 'submit', transactionHash: hash });
        }
        return hash;
      },
      async getFrameReceipt({ hash }) {
        requireCondition(isHash(hash), 'INVALID_TRANSACTION', 'Invalid transaction hash.', 'receipt');
        await checkChain('receipt');
        return parseReceipt(await call('eth_getTransactionReceipt', [hash], 'receipt', hash), hash);
      },
      async waitForFrameReceipt({ hash, expectedFrameCount, timeoutMs = 120_000, pollingIntervalMs = 2_000, signal }) {
        requireCondition(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && Number.isSafeInteger(pollingIntervalMs)
          && pollingIntervalMs > 0 && (expectedFrameCount === undefined || Number.isSafeInteger(expectedFrameCount) && expectedFrameCount > 0),
        'INVALID_TRANSACTION', 'Invalid receipt polling options.', 'receipt');
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (signal?.aborted) throw new FramePayError('ABORTED', 'Stopped waiting; the transaction may still execute.', { phase: 'receipt', transactionHash: hash });
          const receipt = await boundedWait(actions.getFrameReceipt({ hash }), Math.max(1, deadline - Date.now()), signal, hash);
          if (receipt) {
            const failed = receipt.frameReceipts.flatMap((frame, index) => frame.status === '0x0' ? [index] : []);
            if (receipt.status !== '0x1' || failed.length) throw new FramePayError('FRAME_REVERTED', 'The transaction or one of its frames reverted.', { phase: 'receipt', transactionHash: hash, failedFrameIndices: failed });
            requireCondition(expectedFrameCount === undefined || receipt.frameReceipts.length === expectedFrameCount,
              'INVALID_RESPONSE', 'Receipt frame count differs from the expected transaction.', 'receipt');
            return receipt;
          }
          await boundedWait(new Promise((done) => setTimeout(done, Math.min(pollingIntervalMs, Math.max(0, deadline - Date.now())))), Math.max(1, deadline - Date.now()), signal, hash);
        }
        throw new FramePayError('RECEIPT_TIMEOUT', 'Inclusion was not observed before timeout; inspect the hash before retrying.', { phase: 'receipt', transactionHash: hash });
      },
      async getFrameAdmission({ hash }) {
        requireCondition(isHash(hash), 'INVALID_TRANSACTION', 'Invalid transaction hash.', 'admission');
        await checkChain('admission');
        const detail = await call('skandha_explorer_getTransaction', [hash], 'admission', hash) as { hash?: unknown; admission?: { txHash?: unknown; outcome?: unknown; checks?: unknown } | null };
        requireCondition(detail && isHash(detail.hash) && detail.hash.toLowerCase() === hash.toLowerCase(), 'INVALID_RESPONSE', 'Explorer returned a different transaction.', 'admission');
        if (detail.admission === null) return { hash, available: false, outcome: null, checks: [] };
        const admission = detail.admission;
        requireCondition(admission && isHash(admission.txHash) && admission.txHash.toLowerCase() === hash.toLowerCase()
          && ['accepted', 'included', 'rejected', 'replaced', 'dropped'].includes(String(admission.outcome))
          && Array.isArray(admission.checks), 'INVALID_RESPONSE', 'Malformed admission record.', 'admission');
        const checks = admission.checks.map((item: { rule?: unknown; verdict?: unknown; frameIndex?: unknown }) => {
          requireCondition(item && typeof item.rule === 'string' && ['pass', 'fail', 'skipped'].includes(String(item.verdict))
            && (item.frameIndex === undefined || Number.isSafeInteger(item.frameIndex) && Number(item.frameIndex) >= 0),
          'INVALID_RESPONSE', 'Malformed admission rule check.', 'admission');
          return { rule: item.rule, verdict: item.verdict as 'pass' | 'fail' | 'skipped', frameIndex: item.frameIndex as number | undefined };
        });
        return { hash, available: true, outcome: admission.outcome as FrameAdmission['outcome'], checks };
      },
    };
    return actions;
  };
}
