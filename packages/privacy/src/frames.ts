import { Context, Effect, Layer } from 'effect';
import { custom, defineChain, type Address, type Hex } from 'viem';
import { createFrameClient, frame, getProfile, privateKeyToFrameSigner, secp256k1Placeholder, txHash, type FrameTx } from '@framepay/sdk';
import { check, attempt, PrivacyError } from './errors.js';
import type { RpcClient } from './rpc.js';

export interface NativeReceipt {
  transactionHash: Hex; blockNumber: Hex; status: Hex; type: Hex; gasUsed: Hex;
  contractAddress?: Address; frameReceipts?: { status: Hex }[];
  logs: { topics: Hex[]; data: Hex; address: Address }[];
}
export interface FrameOptions { verifyGas?: bigint; executionGas?: bigint; expectFailure?: boolean }
export interface FrameResult { label: string; hash: Hex; receipt: NativeReceipt; admission: unknown }
export async function waitReceipt(rpc: RpcClient, hash: Hex, timeoutMs = 120_000): Promise<NativeReceipt> {
  const deadline = Date.now() + timeoutMs;
  do {
    const receipt = await rpc.request<NativeReceipt | null>('eth_getTransactionReceipt', [hash]);
    if (receipt) {
      check(receipt.transactionHash.toLowerCase() === hash.toLowerCase(), 'Receipt hash mismatch');
      return receipt;
    }
    await new Promise((done) => setTimeout(done, 1_000));
  } while (Date.now() < deadline);
  throw new Error(`Inclusion was not observed; inspect ${hash} before retrying`);
}
export function assertNativeReceipt(receipt: NativeReceipt, expectFailure = false): void {
  check(BigInt(receipt.type) === 6n, 'Expected native frame transaction type 0x06');
  check(receipt.frameReceipts?.length === 2, 'Expected two native frame receipts');
  const frames = receipt.frameReceipts!;
  check(frames[0].status === '0x1', 'EOA verification frame failed');
  check(['0x0', '0x1'].includes(receipt.status) && frames.every((f) => ['0x0', '0x1'].includes(f.status)), 'Invalid receipt statuses');
  if (expectFailure) check(frames[1].status === '0x0', 'Expected a failed execution frame');
  else check(receipt.status === '0x1' && frames[1].status === '0x1', 'Execution failed');
}
export function makeFrameTransport(rpc: RpcClient, key: Hex) {
  const profile = getProfile('ethrex-eip8141-tracer');
  const client = createFrameClient({
    chain: defineChain({ id: 1337, name: 'FramePay local', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } }),
    transport: custom({ request: ({ method, params }) => rpc.request(method, params as readonly unknown[] | undefined) }, { retryCount: 0 }),
    profile: 'ethrex-eip8141-tracer',
  });
  const signer = privateKeyToFrameSigner(key);
  async function build(to: Address, data: Hex, options: FrameOptions = {}): Promise<FrameTx> {
    const transaction = await client.prepareFrameTransaction({ sender: signer.address,
      signatures: [secp256k1Placeholder(profile)], maxFeePerGas: 2_000_000n,
      frames: [frame(profile, 'VERIFY', { scope: 'EXECUTION_AND_PAYMENT', execution: options.verifyGas ?? 30_000n }),
        frame(profile, 'SENDER', { target: to, data, execution: options.executionGas ?? 3_000_000n, state: 1_000_000n })] });
    return client.signFrameTransaction({ transaction, signer });
  }
  return {
    build,
    async send(to: Address, data: Hex, label: string, options: FrameOptions = {}): Promise<FrameResult> {
      const transaction = await build(to, data, options);
      const expected = txHash(profile, transaction);
      try {
        const hash = await client.sendFrameTransaction({ transaction });
        check(hash.toLowerCase() === expected.toLowerCase(), 'Submission hash mismatch');
        const receipt = await waitReceipt(rpc, hash);
        assertNativeReceipt(receipt, options.expectFailure);
        const admission = await client.getFrameAdmission({ hash });
        check(admission.available && ['accepted', 'included'].includes(admission.outcome ?? ''), 'Missing accepted sidecar admission evidence');
        return { label, hash, receipt, admission };
      } catch {
        throw new PrivacyError({ operation: 'submit frame', transactionHash: expected,
          message: `Frame execution or evidence check failed; inspect ${expected} before retrying` });
      }
    },
  };
}
export interface SubmitterService {
  send(to: Address, data: Hex, label: string, options?: FrameOptions): Effect.Effect<FrameResult, PrivacyError>;
}
export class PrivateSubmitter extends Context.Service<PrivateSubmitter, SubmitterService>()('@framepay/privacy/Submitter') {}
export const PrivateSubmitterLive = (rpc: RpcClient, key: Hex) => {
  const transport = makeFrameTransport(rpc, key);
  return Layer.succeed(PrivateSubmitter, { send: (to, data, label, options) => attempt('submit private frame', () => transport.send(to, data, label, options)) });
};
