"use client";
import { useEffect, useRef, useState } from "react";
import { decodeFunctionData, formatEther, type Address, type Hex } from "viem";
import { frameNetworks, type FrameNetworkId, getProfile, quantumFactoryAbi, quantumWalletAbi, passkeyFactoryAbi, passkeyWalletAbi, type Frame } from "@framepay/sdk";
import quantumDeployments from "../../../../../config/quantum.json";
import passkeys from "../../../../../config/passkeys.json";
import { aquaAbi, guardAbi, swapAbi, tokenAbi, type AppDeployment } from "@/lib/defi-contracts";
import { frameBudgets } from "@/lib/frame-budgets";
import { Icon } from "../icon";
import type { Review } from "./use-defi";

export type Flow = "swap" | "token" | "native" | "create" | "cancel" | "wallet" | "claim" | "rules" | "faucet";
type Context = {
  network: FrameNetworkId; deployment: AppDeployment | null;
  sponsor?: { address: string } | null; wallet?: { address: Address; factory?: Address; falconPublicKey?: Hex[] } | null;
  accountAddress?: Address; relayAddress?: Address; sponsored: boolean;
};
type CallInfo = { name: string; target?: string; description: string; optional?: boolean; data?: Hex; value?: bigint; args?: unknown };
type FrameInfo = { mode: string; scope: string; target?: string; title: string; description: string; execution: bigint; state: bigint; value: bigint; data?: Hex; calls?: CallInfo[]; optional?: boolean };
const flows: Record<Flow, { title: string; description: string; before: string; effect: string }> = {
  swap: { title: "Swap", description: "Exchange fpASSET for an exact amount of fpUSD through a maker’s recurring Aqua position.", before: "Read a live quote; check your input cap, minimum output, balance and expiry.", effect: "SwapVM checks price and remaining budgets. Aqua settles the token transfers between you and the maker." },
  token: { title: "Token transfer", description: "Send fpUSD through the transfer guard, with gas paid by the selected payer.", before: "Check the recipient allowlist, balance, transfer cap and expiry.", effect: "The guard transfers tokens and requires the recipient’s balance to increase by the full amount." },
  native: { title: "ETH transfer", description: "Send your own test ETH through the transfer guard. Sponsorship covers gas, not the ETH being sent.", before: "Check the recipient, ETH balance, saved cap and expiry.", effect: "The guard checks the cap and deadline, then forwards the ETH to the recipient." },
  create: { title: "Create recurring buy", description: "Publish a position that buys fpASSET using your fpUSD, within a fixed price and scheduled budget.", before: "Validate the budget, period, price and expiry; build and hash the order with SwapVM.", effect: "Aqua registers the position. Funds stay in your account until another user fills it; no automatic buying bot runs." },
  cancel: { title: "Cancel recurring buy", description: "Stop future fills of a position owned by your account.", before: "Check that the connected account is the position’s maker.", effect: "Aqua docks the order. Unspent funds remain in your account; this does not revoke its shared token allowance." },
  wallet: { title: "Create quantum wallet", description: "A PRF-capable passkey derives an ETHFalcon owner key. ETHFalcon alone authorizes onchain spending; WebAuthn PRF unlocks the key locally.", before: "Register a passkey, evaluate PRF with the constant FramePay.ETHFALCON.v1 salt, and generate the Falcon key in an isolated worker. Save public metadata only. Registration creates zero frames.", effect: "The factory deploys a new CREATE2 wallet with immutable Falcon public key and verifier. Existing P-256 wallets are separate accounts; assets are not migrated automatically." },
  claim: { title: "Get test tokens", description: "Claim 1,000 fpUSD and 100 fpASSET once per account.", before: "Read each token’s claimed flag. Only unclaimed tokens are included.", effect: "Each token contract transfers its fixed claim amount to your account. The paymaster always sponsors this flow." },
  rules: { title: "Save rules", description: "Save your transaction preferences in this browser. Saving rules does not send a transaction.", before: "Validate amounts, expiry, allowed recipients and the sponsorship preference.", effect: "Future drafts use these preferences. Transfer caps and expiry enter signed contract calls; the allowlist remains a browser check. Recurring budgets are set in the position." },
  faucet: { title: "Get test ETH", description: "Ask the devnet faucet to fund your account using skandha_explorer_faucet.", before: "Send your public account address to the faucet service.", effect: "The faucet submits its own funding transaction. The app generates no frame envelope for this request; refresh balances after inclusion." },
};
export function reviewFlow(review: Review): Flow {
  return ({ "Confirm swap": "swap", "Confirm transfer": review.details.find(([label]) => label === "Send")?.[1].endsWith(" ETH") ? "native" : "token", "Create recurring buy": "create", "Cancel recurring buy": "cancel", "Deploy passkey wallet": "wallet", "Get test tokens": "claim" } as Record<string, Flow>)[review.title] ?? "swap";
}
function decodeCall(target: string | undefined, data: Hex, value = 0n): CallInfo {
  for (const abi of [tokenAbi, guardAbi, swapAbi, aquaAbi, passkeyFactoryAbi, passkeyWalletAbi, quantumFactoryAbi, quantumWalletAbi]) {
    try {
      const decoded = decodeFunctionData({ abi, data });
      return { name: `${decoded.functionName}()`, target, description: "Decoded from the reviewed calldata.", data, value, args: decoded.args };
    } catch { /* Try the next contract ABI. */ }
  }
  return { name: data === "0x" ? "No calldata" : data.slice(0, 10), target, description: "Raw call from this review.", data, value };
}
function flowCalls(flow: Flow, context: Context): CallInfo[] {
  const c = context.deployment?.contracts;
  const approve = (target: string | undefined, spender: string, optional: boolean) => ({ name: "approve()", target, description: `Approve ${spender} for the reviewed amount.${optional ? " Omitted if the existing allowance is sufficient." : " Updates the shared allowance to this position’s budget."}`, optional });
  switch (flow) {
    case "swap": return [approve(c?.asset, "SwapVM", true), { name: "swap()", target: c?.router, description: "SwapVM enforces exact output, input cap, deadline and recurring budgets, then settles through Aqua." }];
    case "token": return [approve(c?.usd, "the transfer guard", true), { name: "transferToken()", target: c?.guard, description: "Check cap and expiry; transfer fpUSD and assert the recipient’s balance increase." }];
    case "native": return [{ name: "transferNative()", target: c?.guard, description: "Carry the transfer amount as call value; enforce the cap and expiry before forwarding ETH." }];
    case "create": return [approve(c?.usd, "Aqua", false), { name: "ship()", target: c?.aqua, description: "Register the order and virtual liquidity for the SwapVM application. Tokens remain with the maker." }];
    case "cancel": return [{ name: "dock()", target: c?.aqua, description: "Invalidate this maker’s order for future fills." }];
    case "wallet": return [{ name: "createWallet()", target: context.wallet?.factory ?? (quantumDeployments[context.network] as { factory: string } | null)?.factory, description: context.wallet && !context.wallet.falconPublicKey ? "Deploy or return the legacy wallet for its passkey and site settings." : "Deploy or return the deterministic wallet for this Falcon owner, verifier and genesis domain." }];
    case "claim": return [{ name: "fpUSD.claim()", target: c?.usd, description: "Claim 1,000 fpUSD if not already claimed.", optional: true }, { name: "fpASSET.claim()", target: c?.asset, description: "Claim 100 fpASSET if not already claimed.", optional: true }];
    default: return [];
  }
}
function plannedFrames(flow: Flow, context: Context, passkey: boolean, sponsored: boolean, calls: CallInfo[]): FrameInfo[] {
  if (flow === "rules" || flow === "faucet") return [];
  const relay = passkey || flow === "wallet";
  const result: FrameInfo[] = [{ mode: "VERIFY", scope: sponsored ? "EXECUTION" : "EXECUTION_AND_PAYMENT", target: relay ? context.relayAddress : context.accountAddress, title: relay ? "Relay authorization" : "Account authorization", description: `Verify the ${relay ? "disposable relay" : "test account"}’s SECP256K1 authorization for the envelope.${sponsored ? " Approve execution only." : " Approve execution and payment from that account."}`, ...frameBudgets.account, value: 0n }];
  if (sponsored) result.push({ mode: "VERIFY", scope: "PAYMENT", target: context.sponsor?.address, title: "Paymaster approval", description: "FramePayPaymaster reads the maximum transaction cost, checks its ceiling, and approves gas payment from its finite balance.", ...frameBudgets.payment, value: 0n });
  if (passkey && flow !== "wallet") result.push({ mode: "SENDER", scope: "NONE", target: context.wallet?.address, title: "Wallet.execute()", description: context.wallet?.falconPublicKey ? "The wallet verifies the ETHFalcon signature over the batch challenge, checks nonce and expiry, then executes the calls atomically. Passkey PRF runs only in the browser." : "The wallet verifies WebAuthn/P-256, RP ID, origin, user presence/verification, nonce and deadline, then executes the batch.", ...(context.wallet?.falconPublicKey ? frameBudgets.quantum : frameBudgets.wallet), value: 0n, calls });
  else for (const call of calls) result.push({ mode: "SENDER", scope: "NONE", target: call.target, title: call.name, description: call.description, ...(flow === "wallet" ? frameBudgets.deployment : frameBudgets.eoa), value: call.value ?? 0n, optional: call.optional, calls: [call] });
  return result;
}
function actualFrame(frame: Frame, sender: Address, index: number, deployment: boolean): FrameInfo {
  const profile = getProfile("ethrex-eip8141-tracer");
  const mode = Object.entries(profile.frameModes).find(([, value]) => value === frame.mode)?.[0] ?? String(frame.mode);
  const scope = Object.entries(profile.approveScopes).find(([, value]) => value === (frame.flags & 3))?.[0] ?? "NONE";
  const target = frame.target ?? sender;
  return { mode, scope, target, ...frame.limits, value: frame.value, data: frame.data,
    title: mode === "VERIFY" ? index === 0 ? "Account / relay authorization" : "Paymaster approval" : decodeCall(target, frame.data).name,
    description: mode === "VERIFY" ? index === 0 ? "SECP256K1 authorization of the outer envelope. The wallet checks spending authorization inside its execution call." : "The paymaster independently approves payment." : deployment ? "The factory deploys the passkey-owned wallet." : "Executed directly as the frame sender.",
    calls: mode === "VERIFY" ? undefined : [decodeCall(target, frame.data, frame.value)] };
}
const pretty = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);

export function HowItWorks({ initialFlow, context, review, close }: { initialFlow: Flow; context: Context; review?: Review | null; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [flow, setFlow] = useState(initialFlow);
  const [passkey, setPasskey] = useState(!!context.wallet || !context.accountAddress);
  const [sponsored, setSponsored] = useState(context.sponsored);
  const [copied, setCopied] = useState("");
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => { body.current?.scrollTo({ top: 0 }); }, [flow, passkey, sponsored]);
  const current = flows[flow];
  const quantum = !!context.wallet?.falconPublicKey || (!context.wallet && flow === "wallet");
  const quantumDeployment = quantumDeployments[context.network] as { factory: string; verifier: string } | null;
  const wallet = review ? !!review.walletBatch : passkey;
  const pays = review?.transaction ? review.transaction.frames.some(f => (f.flags & 3) === 1) : review?.walletBatch || flow === "wallet" || flow === "claim" || wallet ? true : sponsored;
  const calls = review?.walletBatch ? review.walletBatch.calls.map(call => decodeCall(call.target, call.data, call.value)) : flowCalls(flow, context);
  const frames = review?.transaction ? review.transaction.frames.map((frame, index) => actualFrame(frame, review.transaction!.sender, index, flow === "wallet")) : plannedFrames(flow, context, wallet, !!pays, calls);
  const c = context.deployment?.contracts;
  const entries = [
    { name: "ZKNOX_ethfalcon", address: quantumDeployment?.verifier, role: "Pinned official ETHFalcon-512 Keccak verifier. Called inside the wallet execution frame; not a separate frame. Experimental, unaudited upstream.", show: quantum && (wallet || flow === "wallet") },
    { name: "FramePayPaymaster", address: context.sponsor?.address, role: "Approves and funds gas; it does not provide swap capital or transfer value.", show: !!frames.length && !!pays },
    { name: quantum ? "FramePayQuantumWallet" : "FramePayPasskeyWallet", address: context.wallet?.address, role: quantum ? "ETHFalcon is the sole onchain spending authority. The PRF-derived key signs the atomic batch. No P-256 verification, admin or recovery key." : "Holds assets; verifies WebAuthn and executes the atomic call batch.", show: (!!frames.length && wallet) || flow === "wallet" },
    { name: quantum ? "FramePayQuantumFactory" : "FramePayPasskeyFactory", address: quantum ? quantumDeployment?.factory : passkeys[context.network]?.factory, role: quantum ? "CREATE2 deployment with an immutable Falcon owner, verifier and chain domain." : "CREATE2 deployment with immutable passkey public key and domain settings.", show: flow === "wallet" },
    { name: "FramePayRecurringSwapVM", address: c?.router, role: "Runs the recurring-buy program: price, period budget, lifetime budget and expiry.", show: ["swap", "create", "cancel", "rules"].includes(flow) },
    { name: "Official 1inch Aqua", address: c?.aqua, role: "Registers/docks positions and settles swaps using maker balances and allowances.", show: ["swap", "create", "cancel"].includes(flow) },
    { name: "FramePayTransferGuard", address: c?.guard, role: "Enforces transfer amount and deadline; token transfers also check minimum received.", show: ["token", "native", "rules"].includes(flow) },
    { name: "fpUSD · AppTestToken", address: c?.usd, role: "6-decimal test token; claims, allowances and token balances.", show: ["swap", "token", "create", "cancel", "claim"].includes(flow) },
    { name: "fpASSET · AppTestToken", address: c?.asset, role: "18-decimal test asset exchanged for fpUSD.", show: ["swap", "create", "cancel", "claim"].includes(flow) },
    { name: "P-256 verifier", address: "0x0000000000000000000000000000000000000100", role: "Called inside wallet verification when supported; OpenZeppelin provides a Solidity fallback. This is not a separate frame.", show: !!frames.length && wallet && !quantum && flow !== "wallet" },
  ].filter(item => item.show);
  async function copy(address: string) {
    try { await navigator.clipboard.writeText(address); setCopied(`Copied ${address}`); }
    catch { setCopied("Copy unavailable. Select the address text to copy it."); }
  }
  return <dialog ref={ref} className="defi-how" aria-labelledby="how-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === ref.current) { const r = ref.current.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); } }}>
    <header className="defi-how-header"><div><span className="defi-eyebrow">FROM YOUR CLICK TO THE CHAIN</span><h2 id="how-title">How it works</h2></div><button className="defi-icon-button" onClick={close} aria-label="Close how it works" autoFocus><Icon name="close" /></button></header>
    <div className="defi-how-controls">
      {review ? <div><strong>{review.title}</strong><small>{review.transaction ? "Actual prepared envelope" : "Reviewed wallet calls · envelope built after passkey approval"}</small></div> : <>
        <label>Flow<select aria-label="Flow" value={flow} onChange={event => setFlow(event.target.value as Flow)}>{Object.entries(flows).map(([value, info]) => <option key={value} value={value}>{info.title}</option>)}</select></label>
        {!["rules", "faucet", "wallet"].includes(flow) && <><label>Account<select aria-label="Account" value={passkey ? "passkey" : "eoa"} onChange={event => setPasskey(event.target.value === "passkey")}><option value="passkey">Passkey wallet</option><option value="eoa">Disposable account</option></select></label><label>Gas payer<select aria-label="Gas payer" disabled={passkey || flow === "claim"} value={pays ? "sponsor" : "self"} onChange={event => setSponsored(event.target.value === "sponsor")}><option value="sponsor">FramePay paymaster</option><option value="self">Self-paid</option></select></label></>}
      </>}
    </div>
    <div className="defi-how-body" ref={body}>
      {!context.deployment && <p className="defi-how-note">No DeFi deployment is configured on this network. The flow below describes the local implementation; unavailable addresses are not shown.</p>}
      <p className="defi-how-lead">{current.description}</p>
      <ol className="defi-how-path"><li><span>1</span><strong>Prepare</strong><p>{current.before}</p></li><li><span>2</span><strong>{frames.length ? "Authorize" : "Save / request"}</strong><p>{!frames.length ? "No signature or app-generated frames are needed." : wallet && flow !== "wallet" ? quantum ? "Passkey approval returns a deterministic PRF seed. A temporary worker regenerates the Falcon key, signs the batch challenge, wipes accessible buffers and terminates. The relay signs the outer envelope." : "Approve the exact batch with your passkey. The relay signs the outer frame envelope." : flow === "wallet" ? "Review the predicted wallet address. The relay signs the sponsored deployment envelope." : "Your disposable account signs the frame envelope, binding its calls, nonce and gas limits."}</p></li><li><span>3</span><strong>{frames.length ? "Execute" : "Result"}</strong><p>{current.effect}</p></li></ol>
      <section aria-labelledby="how-frames-title"><div className="defi-how-section-title"><h3 id="how-frames-title">{review ? "Frames for this review" : "Generated frames"}</h3><span className="defi-pill">{frames.length}{!review && frames.some(frame => frame.optional) ? " maximum" : ""} frames</span></div>
        {!review && frames.length > 0 && <p className="defi-small">Illustrative layout. Optional approvals and already-claimed tokens are omitted when preparing. Use “How it works” in a transaction review to inspect its exact calls.</p>}
        {frames.length === 0 ? <p className="defi-how-note">{flow === "rules" ? "0 frames. Saving rules writes to localStorage; it does not install persistent wallet permissions." : "0 app-generated frames. The faucet service owns the funding transaction."}</p> : <>
          <p className="defi-how-legend"><strong>VERIFY</strong> grants authorization. <strong>SENDER</strong> executes as the envelope sender. Frame numbers start at 0.</p>
          <ol className="defi-how-frames">{frames.map((frame, index) => <li key={index}>
            <details open={index === frames.length - 1}><summary><span className="defi-how-number">{index}</span><span><strong>{frame.title}</strong><small>{frame.mode} · {frame.scope}{frame.optional ? " · if needed" : ""}</small></span><Icon name="chevron" size={15} /></summary>
              <div className="defi-how-frame-body"><p>{frame.description}</p><dl><div><dt>Target</dt><dd><code>{frame.target ?? (index === 0 ? "Envelope sender (assigned during preparation)" : wallet ? "Your wallet address after creation" : "Not deployed on this network")}</code></dd></div><div><dt>Gas limits</dt><dd>{frame.execution.toLocaleString()} execution / {frame.state.toLocaleString()} state</dd></div><div><dt>Frame value</dt><dd>{!review && flow === "native" && frame.mode === "SENDER" && !wallet ? "Your ETH transfer amount" : `${formatEther(frame.value)} ETH`}</dd></div></dl>
                {frame.calls && <div className="defi-how-calls"><h4>{wallet && flow !== "wallet" ? "Calls inside this single frame" : "Application call"}</h4>{wallet && flow !== "wallet" && <p className="defi-small">These are contract calls within Wallet.execute(), not additional frames. Call value is supplied by the wallet.</p>}{frame.calls.map((call, i) => <div className="defi-how-call" key={i}><strong>{i + 1}. {call.name}{call.optional && !review ? " (if needed)" : ""}</strong><code>{call.target ?? "Address available after deployment"}</code><p>{call.description}</p>{call.value !== undefined && <small>Call value: {formatEther(call.value)} ETH</small>}{call.data && <details><summary>Decoded arguments & calldata</summary><pre>{pretty({ arguments: call.args ?? [], calldata: call.data, valueWei: call.value ?? 0n })}</pre></details>}</div>)}</div>}
                {frame.data === "0x" && <p className="defi-small">Calldata: 0x (empty)</p>}
              </div>
            </details>
          </li>)}</ol>
          {review?.walletBatch && <details className="defi-how-proof"><summary>{quantum ? "Falcon challenge and replay protection" : "Passkey challenge and replay protection"}</summary><dl><div><dt>Wallet nonce</dt><dd>{review.walletBatch.nonce.toString()}</dd></div><div><dt>Expiry</dt><dd>{new Date(review.deadline! * 1000).toLocaleString()}</dd></div><div><dt>Challenge</dt><dd><code>{review.walletBatch.challenge}</code></dd></div></dl><p>The signed challenge binds the ordered calls, wallet, chain ID, genesis domain, nonce and expiry. Approvals are requested only after Confirm & send. Quantum wallets submit only an ETHFalcon signature. WebAuthn PRF unlocks the key locally.</p></details>}
          <p className="defi-how-note">{flow === "wallet" ? "Passkey registration creates no frames. These three frames deploy the wallet; later spending is authorized by its configured public keys." : wallet ? "Wallet signature verification happens inside Wallet.execute(), not in frame 0. All calls in this wallet batch, including approvals, revert together if one fails." : "For disposable-account transactions, an earlier approval frame may remain effective if a later application frame fails."} Gas limits are caps, not estimated usage.</p>
        </>}
      </section>
      <section aria-labelledby="how-contracts-title"><div className="defi-how-section-title"><h3 id="how-contracts-title">Contracts involved</h3><span>{frameNetworks[context.network].name} · 1337</span></div>
        {entries.length ? <div className="defi-how-contracts">{entries.map(entry => <article key={entry.name}><h4>{entry.name}</h4><p>{entry.role}</p><div><code>{entry.address ?? "Not deployed / wallet not created"}</code>{entry.address && <button className="defi-icon-button" onClick={() => void copy(entry.address!)} aria-label={`Copy ${entry.name} address`}><Icon name="copy" size={15} /></button>}</div></article>)}</div> : <p className="defi-small">This action makes no direct contract call from the app.</p>}
        {flow === "rules" && <p className="defi-small">The transfer guard shown here is used by future transfers, not by Save rules. SwapVM enforces price/budget rules on future swaps.</p>}
      </section>
      {frames.length > 0 && <p className="defi-how-note">The SDK submits once with eth_sendFrameTransaction and waits for successful receipts for every frame. A gateway hash is an acknowledgement, not proof of execution.</p>}
      {["create", "cancel"].includes(flow) && <p className="defi-small">Sharing/importing a position uses public JSON and read-only verification; it creates no frames.</p>}
      <p className="defi-small" role="status">{copied}</p>
    </div>
    <footer className="defi-how-footer"><span>{review ? "Viewing this explanation does not sign or submit anything." : "Explore the flow without creating or sending a transaction."}</span><button className="defi-secondary" onClick={close}>{review ? "Back to review" : "Got it"}</button></footer>
  </dialog>;
}
