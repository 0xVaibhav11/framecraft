import { defineChain, http } from 'viem';
import { createFrameClient, frame, getProfile, type FrameSigner } from '@framepay/sdk';

const gateway = 'http://localhost:14337/rpc';
const chain = defineChain({
  id: 1337, name: 'Local frame devnet',
  nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [gateway] } },
});

// Importing this example does not send anything. Supply your signer and call the function explicitly.
// This is a self-paid baseline. Gas values come from the tested workshop preset, not SDK estimation.
export async function transfer(signer: FrameSigner) {
  const profile = getProfile('ethrex-eip8141-tracer');
  const client = createFrameClient({ chain, transport: http(gateway, { retryCount: 0 }), profile: 'ethrex-eip8141-tracer' });
  const transaction = await client.prepareFrameTransaction({
    sender: signer.address,
    maxFeePerGas: 2_000_000_000n,
    frames: [
      frame(profile, 'VERIFY', { scope: 'EXECUTION_AND_PAYMENT', execution: 30_000n }),
      frame(profile, 'SENDER', {
        target: '0x8943545177806ED17B9F23F0a21ee5948eCaa776',
        value: 1_000_000_000n, execution: 50_000n, state: 200_000n,
      }),
    ],
  });
  const signed = await client.signFrameTransaction({ transaction, signer });
  const hash = await client.sendFrameTransaction({ transaction: signed });
  const receipt = await client.waitForFrameReceipt({ hash, expectedFrameCount: 2 });
  const admission = await client.getFrameAdmission({ hash });
  return { hash, receipt, admission };
}
