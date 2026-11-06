// EVMcrispr's frame layout (the FrameSpecs of a `frame:tx` FrameAction) as
// FramePay SDK frames, and what this site refuses to send. Plain .mjs so the
// node tests can import it (tests/evml-frames.test.mjs).
import { frame, frameNetworks, getProfile } from "@framepay/sdk";

const profile = getProfile("ethrex-eip8141-tracer");
const MODES = { verify: "VERIFY", sender: "SENDER", default: "DEFAULT" };
const SCOPES = { execution: "EXECUTION", payment: "PAYMENT", both: "EXECUTION_AND_PAYMENT" };
/** Kept under the 16 frames the FramePay app's gateway proxy admits. */
export const MAX_FRAMES = 16;

/**
 * Gas per frame when the script writes none, as the FramePay DeFi app sizes
 * them (apps/poc/src/lib/frame-budgets.ts): self-verify, paymaster verify,
 * and one EOA call.
 */
export const frameBudgets = {
  account: { execution: 30_000n, state: 0n },
  payment: { execution: 50_000n, state: 0n },
  eoa: { execution: 600_000n, state: 1_500_000n },
};

/**
 * Frames up to the last VERIFY frame (a pre-verify DEFAULT frame sits inside).
 * @param {readonly { mode: string }[]} specs
 */
export function prefixLength(specs) {
  let last = -1;
  specs.forEach((spec, i) => { if (spec.mode === "verify") last = i; });
  return last + 1;
}

/**
 * Validation frames keep the gas `frame:tx` gave them (30,000 / 50,000) and
 * no state gas. Body frames take `exec --gas` and `frame:tx --state-gas` when
 * written, else `budgets.eoa`: nothing estimates frames on this devnet.
 * @param {readonly import("@evmcrispr/sdk").FrameSpec[]} specs
 * @param {{ account: Budget; payment: Budget; eoa: Budget }} budgets
 * @returns {import("@framepay/sdk").Frame[]}
 * @typedef {{ readonly execution: bigint; readonly state: bigint }} Budget
 */
export function toFrames(specs, budgets) {
  const prefix = prefixLength(specs);
  return specs.map((spec, i) => {
    const fallback = spec.mode === "verify" ? (spec.target === null ? budgets.account : budgets.payment) : budgets.eoa;
    return frame(profile, MODES[spec.mode], {
      target: spec.target,
      data: spec.data,
      value: spec.value,
      scope: spec.approve ? SCOPES[spec.approve] : undefined,
      flags: spec.atomic ? profile.flagBits.ATOMIC_BATCH : 0,
      execution: spec.gas ?? fallback.execution,
      state: i < prefix ? 0n : spec.stateGas ?? fallback.state,
    });
  });
}

/**
 * Why this site cannot send `action` for `sender`, or undefined when it can.
 * @param {import("@evmcrispr/sdk").FrameAction} action
 * @param {string} sender
 */
export function refusal(action, sender) {
  const chainId = frameNetworks.devnet.chainId;
  if (action.chainId !== chainId)
    return `Frame transactions are sent on the FramePay devnets only (chain ${chainId}), not on chain ${action.chainId}.`;
  if (action.from.toLowerCase() !== sender.toLowerCase())
    return `This frame transaction is from ${action.from}, but this page signs only for its test account ${sender}: drop the other sender.`;
  if (action.mempool !== "alt")
    return "The FramePay gateway takes frame transactions for the alt mempool only: drop --mempool canonical.";
  if (action.frames.length > MAX_FRAMES)
    return `This frame transaction has ${action.frames.length} frames; the FramePay gateway takes at most ${MAX_FRAMES}.`;
  return undefined;
}
