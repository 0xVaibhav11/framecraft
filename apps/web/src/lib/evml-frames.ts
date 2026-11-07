// Sends the frame transactions EVMcrispr's `frame:tx` builds (a FrameAction)
// through the FramePay SDK: prepared, signed by the page's disposable key and
// submitted to the selected devnet's gateway, then followed to its receipt.
import type { ActionHandlers } from "@evmcrispr/core";
import { frameNetworks, type FrameNetworkId, type FrameReceipt, type FrameSigner } from "@framepay/sdk";
import type { Hex } from "viem";
import { frameBudgets, refusal, toFrames } from "./evml-frame-layout.mjs";
import { frameClient } from "./frame-rpc";

/** The fees the DeFi app uses on this devnet. */
const FEES = { maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 1_000_000n };

export type SentFrameTransaction = { hash: Hex; frameCount: number; receipt?: FrameReceipt; error?: string; outcome?: 'rejected' };

export function makeFrameHandler({ networkId, signer, onUpdate }: {
  networkId: FrameNetworkId;
  signer: FrameSigner;
  /** Each transaction as it is sent and when its receipt arrives. */
  onUpdate?: (sent: SentFrameTransaction) => void;
}): ActionHandlers["frame"] {
  return async (action, ctx) => {
    const refused = refusal(action, signer.address);
    if (refused) throw new Error(refused);
    const client = frameClient(networkId);
    const frames = toFrames(action.frames, frameBudgets);
    const prepared = await client.prepareFrameTransaction({ sender: signer.address, frames, ...FEES });
    const signed = await client.signFrameTransaction({ transaction: prepared, signer });
    const hash = await client.sendFrameTransaction({ transaction: signed });
    ctx.onSent?.(hash);
    onUpdate?.({ hash, frameCount: frames.length });
    ctx.onLog(`:success:Frame transaction ${hash} admitted by the ${frameNetworks[networkId].name} gateway (${frames.length} frames, nonce ${prepared.nonceSeq})`);
    let receipt: FrameReceipt;
    try {
      receipt = await client.waitForFrameReceipt({ hash, expectedFrameCount: frames.length, signal: ctx.signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onUpdate?.({ hash, frameCount: frames.length, error: message });
      throw new Error(`${hash}: ${message}`);
    }
    onUpdate?.({ hash, frameCount: frames.length, receipt });
    ctx.onLog(`${receipt.status === "0x1" ? ":success:" : ":warning:"}Frame transaction ${hash} included in block ${BigInt(receipt.blockNumber)}`);
    receipt.frameReceipts.forEach(({ status }, i) =>
      ctx.onLog(`${status === "0x1" ? ":success:" : ":warning:"}Frame ${i + 1} (${action.frames[i]?.mode ?? "?"}): ${status === "0x1" ? "succeeded" : "failed"}`));
    return receipt;
  };
}

/** Every other action that would need a signature: this page has no wallet. */
export function refuseOtherActions(): Partial<ActionHandlers> {
  const refuse = (what: string) => async () => {
    throw new Error(`This page sends frame transactions only, so it cannot send ${what}: put the calls inside \`frame:tx ( … )\`.`);
  };
  return {
    transaction: refuse("a plain transaction"),
    batched: refuse("a batch"),
    smartBatch: refuse("a smart batch"),
    wallet: refuse("a wallet request"),
  };
}
