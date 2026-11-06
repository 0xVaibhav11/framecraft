import { parseEther, type Address } from 'viem';
import type { FrameSigner, TransferPayment } from '@framepay/sdk';
import { client } from './extend-viem.js';

/** Caller supplies an EOA signer and its selected payment option; this function does not broadcast. */
export async function prepareUserTransfer(signer: FrameSigner, recipient: Address, payment: TransferPayment) {
  const transaction = await client.prepareTransfer({
    sender: signer.address,
    transfer: { to: recipient, value: parseEther('0.000000001') },
    payment,
    rules: {
      allowedRecipients: [recipient],
      maxValue: parseEther('0.001'),
      maxFeePerGas: 2_000_000_000n,
    },
    maxFeePerGas: 2_000_000_000n,
  });
  // Present this exact transaction to the user before calling signFrameTransaction.
  return transaction;
}

// payment: { type: 'self' }
// or: { type: 'paymaster', address: deployedPaymaster, verificationData: '0x' }
// A paymaster's deployed code does not establish eligibility or guarantee approval.
