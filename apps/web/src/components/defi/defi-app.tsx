"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { encodeAbiParameters, encodeFunctionData, formatUnits, keccak256, parseAbiParameters, type Address, type Hex } from "viem";
import { BrandMark, Icon } from "../icon";
import { NetworkBadge } from "../network";
import { rpc, shortAddress } from "@/lib/rpc";
import { aquaAbi, guardAbi, swapAbi, tokenAbi, unpackOrder, type Position } from "@/lib/defi-contracts";
import { amount, assertSwap, assertTransfer, defaultRules, loadRules, validateRules } from "@/lib/defi-rules.mjs";
import { useDefi, type Review } from "./use-defi";

type Tab = "Swap" | "Transfer" | "Positions" | "Rules";
type Rules = typeof defaultRules;
type PositionState = { available: bigint; totalSpent: bigint; epochSpent: bigint; inactive: boolean; expiry: number; nextPeriod: number };
const display = (value: bigint, decimals = 6) => formatUnits(value, decimals);
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="defi-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Token({ asset = false, native = false }: { asset?: boolean; native?: boolean }) {
  return <span className={`defi-token ${asset ? "asset" : ""} ${native ? "native" : ""}`}>{native ? "Ξ" : asset ? "◈" : "$"}</span>;
}
function ReviewModal({ review, busy, confirm, cancel }: { review: Review; busy: boolean; confirm: () => void; cancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="defi-review" aria-labelledby="review-title" onCancel={event => { event.preventDefault(); if (!busy) cancel(); }}>
    <div className="defi-card-top"><span className="defi-eyebrow">READY WHEN YOU ARE</span><button aria-label="Close review" className="defi-icon-button" disabled={busy} onClick={cancel}><Icon name="close" /></button></div>
    <h2 id="review-title">{review.title}</h2><p>Review the amounts and rules before signing.</p>
    <dl>{review.details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <div className="defi-review-checks">{review.assertions.map(item => <p key={item}><Icon name="check" size={15} />{item}</p>)}</div>
    <p className="defi-small">This sends a real transaction on the selected test network. Token approvals, when needed, are limited to the reviewed amount.</p>
    <button className="defi-primary" disabled={busy} onClick={confirm}>{busy ? "Signing…" : "Confirm & send"}<Icon name="arrow" size={17} /></button>
    <button className="defi-text-button" disabled={busy} onClick={cancel}>Back to editing</button>
  </dialog>;
}

export function DefiApp() {
  const app = useDefi();
  const { deployment: config, account, publicClient, balances, locked, busy } = app;
  const [tab, setTab] = useState<Tab>("Swap");
  const [sponsored, setSponsored] = useState(true);
  const [rules, setRules] = useState<Rules>({ ...defaultRules });
  const [ruleDraft, setRuleDraft] = useState<Rules>({ ...defaultRules });
  const [receive, setReceive] = useState("10");
  const [recipient, setRecipient] = useState("");
  const [transferAmount, setTransferAmount] = useState("5");
  const [transferToken, setTransferToken] = useState<"usd" | "eth">("usd");
  const [selectedHash, setSelectedHash] = useState<string>("");
  const [quote, setQuote] = useState<{ input: bigint; output: bigint } | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [positionStates, setPositionStates] = useState<Record<string, PositionState>>({});
  const [positionForm, setPositionForm] = useState({ name: "My recurring buy", budget: "100", perPeriod: "10", period: "5", price: "10", hours: "24" });
  const [importText, setImportText] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const accountFile = useRef<HTMLInputElement>(null);
  const positions = useMemo(() => config ? [config.seedPosition, ...app.positions.filter(item => item.orderHash !== config.seedPosition.orderHash)] : [], [config, app.positions]);
  const selected = positions.find(item => item.orderHash === selectedHash) ?? positions[0];
  const selectedState = selected ? positionStates[selected.orderHash] : undefined;
  const [clock, setClock] = useState(Date.now());
  const profileKey = `${app.storageKey}:rules`;

  useEffect(() => {
    try { const value = loadRules(localStorage.getItem(profileKey)) as Rules; setRules(value); setRuleDraft(value); if (value.requireSponsor) setSponsored(true); }
    catch { /* Use safe defaults if browser storage is unavailable. */ }
  }, [profileKey]);
  useEffect(() => { if (app.wallet) setSponsored(true); }, [app.wallet]);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 10_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!config || !app.ready) return;
    let active = true;
    void (async () => {
      const block = await rpc<{ timestamp: Hex }>("eth_getBlockByNumber", ["latest", false], app.network.id);
      const now = BigInt(block.timestamp);
      const entries = await Promise.all(positions.map(async position => {
        const p = position.policy;
        const schedule = BigInt(p.schedule), start = schedule & ((1n << 64n) - 1n), period = (schedule >> 64n) & ((1n << 32n) - 1n), expiry = schedule >> 96n;
        if (period === 0n) throw new Error("Invalid position period.");
        try {
          const [usage, liquidity] = await Promise.all([
            publicClient.readContract({ address: config.contracts.router, abi: swapAbi, functionName: "usage", args: [position.orderHash] }),
            publicClient.readContract({ address: config.contracts.aqua, abi: aquaAbi, functionName: "safeBalances", args: [position.order.maker, config.contracts.router, position.orderHash, config.contracts.asset, config.contracts.usd] }),
          ]);
          const epoch = now >= start ? (now - start) / period : 0n;
          const epochSpent = usage[0] === epoch ? usage[1] : 0n;
          const remaining = [BigInt(p.periodBudget) - epochSpent, BigInt(p.totalBudget) - usage[2], liquidity[1]];
          const available = now < start || now >= expiry ? 0n : remaining.reduce((a, b) => a < b ? a : b);
          return [position.orderHash, { available: available > 0n ? available : 0n, totalSpent: usage[2], epochSpent, inactive: false, expiry: Number(expiry), nextPeriod: Number(start + (epoch + 1n) * period) }] as const;
        } catch { return [position.orderHash, { available: 0n, totalSpent: 0n, epochSpent: 0n, inactive: true, expiry: Number(expiry), nextPeriod: 0 }] as const; }
      }));
      if (active) setPositionStates(Object.fromEntries(entries));
    })().catch(() => { if (active) setPositionStates({}); });
    return () => { active = false; };
  }, [positions, config, app.ready, app.refreshVersion, app.network.id, publicClient, clock]);

  useEffect(() => {
    setQuote(null); setQuoteError("");
    if (!selected || !config || !app.ready) return;
    let active = true;
    const timer = setTimeout(() => {
      setQuoting(true);
      void (async () => {
        const output = amount(receive, 6, "Receive amount");
        const takerData = await publicClient.readContract({ address: config.contracts.router, abi: swapAbi, functionName: "buildTakerData", args: [config.contracts.asset, config.contracts.usd, (1n << 128n) - 1n, 0] });
        const result = await publicClient.readContract({ address: config.contracts.router, abi: swapAbi, functionName: "quote", args: [unpackOrder(selected.order), output, takerData] });
        if (active) setQuote({ input: result[0], output: result[1] });
      })().catch(error => { if (active) setQuoteError(error.message.includes("Receive amount") ? error.message : "This amount is unavailable. Check the position’s remaining budget and expiry."); })
        .finally(() => { if (active) setQuoting(false); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [receive, selected, config, app.ready, app.refreshVersion, publicClient, clock]);

  async function deadline() {
    validateRules(rules);
    const block = await rpc<{ timestamp: Hex }>("eth_getBlockByNumber", ["latest", false], app.network.id);
    return Number(BigInt(block.timestamp)) + Number(rules.deadlineMinutes) * 60;
  }
  const call = (to: Address, data: Hex, value = 0n) => ({ to, data, value });
  async function claimTokens() {
    if (!config) return;
    const calls = (["usd", "asset"] as const).filter(name => !app.claimed[name]).map(name => call(config.contracts[name], encodeFunctionData({ abi: tokenAbi, functionName: "claim" })));
    if (!calls.length) throw new Error("This account has already claimed both test tokens.");
    await app.prepare({ title: "Get test tokens", details: [["Receive", [!app.claimed.usd && "1,000 fpUSD", !app.claimed.asset && "100 fpASSET"].filter(Boolean).join(" + ")]],
      assertions: ["One claim per account", "No ETH needed for sponsored gas"], calls, sponsored: true });
  }
  async function swap() {
    if (!config || !account || !selected || !quote) throw new Error("Wait for a live quote and connect your test account.");
    if (selected.order.maker.toLowerCase() === account.address.toLowerCase()) throw new Error("Choose another maker’s position to swap. Manage your own positions in the Positions tab.");
    assertSwap(rules, { input: quote.input, output: quote.output, sponsored });
    if (balances.asset < quote.input) throw new Error("Get test tokens first; your fpASSET balance is too low.");
    const expires = await deadline();
    const data = await publicClient.readContract({ address: config.contracts.router, abi: swapAbi, functionName: "buildTakerData", args: [config.contracts.asset, config.contracts.usd, quote.input, expires] });
    // Revalidate the quote immediately before preparing the exact amounts to sign.
    const fresh = await publicClient.readContract({ address: config.contracts.router, abi: swapAbi, functionName: "quote", args: [unpackOrder(selected.order), quote.output, data] });
    if (fresh[0] !== quote.input || fresh[1] !== quote.output) throw new Error("The quote changed. Review the updated amounts.");
    const allowance = await publicClient.readContract({ address: config.contracts.asset, abi: tokenAbi, functionName: "allowance", args: [account.address, config.contracts.router] });
    const calls = allowance < quote.input ? [call(config.contracts.asset, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [config.contracts.router, quote.input] }))] : [];
    calls.push(call(config.contracts.router, encodeFunctionData({ abi: swapAbi, functionName: "swap", args: [unpackOrder(selected.order), quote.output, data] })));
    await app.prepare({ title: "Confirm swap", details: [["You pay", `${display(quote.input, 18)} fpASSET`], ["You receive", `${display(quote.output)} fpUSD`], ["Position", selected.name], ["Expires", new Date(expires * 1000).toLocaleTimeString()]],
      assertions: ["Exact output enforced on-chain", "Input cannot exceed the quoted amount", "Position budgets and expiry enforced on-chain"], calls, sponsored, deadline: expires });
  }
  async function transfer() {
    if (!config || !account) throw new Error("Create a test account first.");
    const native = transferToken === "eth";
    const value = amount(transferAmount, native ? 18 : 6, "Transfer amount");
    const to = recipient.trim() as Address;
    const maximum = assertTransfer(rules, { recipient: to, sender: account.address, value, native, sponsored });
    if ((native ? balances.eth : balances.usd) < value) throw new Error("Your balance does not cover the transfer. Sponsorship covers gas only.");
    const expires = await deadline();
    const calls = [];
    if (native) calls.push(call(config.contracts.guard, encodeFunctionData({ abi: guardAbi, functionName: "transferNative", args: [to, maximum, BigInt(expires)] }), value));
    else {
      const allowance = await publicClient.readContract({ address: config.contracts.usd, abi: tokenAbi, functionName: "allowance", args: [account.address, config.contracts.guard] });
      if (allowance < value) calls.push(call(config.contracts.usd, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [config.contracts.guard, value] })));
      calls.push(call(config.contracts.guard, encodeFunctionData({ abi: guardAbi, functionName: "transferToken", args: [config.contracts.usd, to, value, maximum, value, BigInt(expires)] })));
    }
    await app.prepare({ title: "Confirm transfer", details: [["Send", `${transferAmount} ${native ? "ETH" : "fpUSD"}`], ["Recipient", to], ["Amount cap", `${display(maximum, native ? 18 : 6)} ${native ? "ETH" : "fpUSD"}`], ["Expires", new Date(expires * 1000).toLocaleTimeString()]],
      assertions: ["Recipient checked against your app rules", "Amount cap and deadline enforced on-chain", ...(native ? [] : ["Recipient must receive the full token amount"])], calls, sponsored, deadline: expires });
  }
  async function createPosition() {
    if (!config || !account) throw new Error("Create a test account first.");
    if (rules.requireSponsor && !sponsored) throw new Error("Your rules require sponsorship.");
    const totalBudget = amount(positionForm.budget, 6, "Total budget");
    const periodBudget = amount(positionForm.perPeriod, 6, "Period budget");
    const spendUnits = amount(positionForm.price, 6, "Price");
    if (periodBudget > totalBudget) throw new Error("Period budget cannot exceed the total budget.");
    if (totalBudget > balances.usd) throw new Error("Your fpUSD balance must cover this position’s total budget.");
    if (!/^\d+$/.test(positionForm.period) || Number(positionForm.period) < 1 || Number(positionForm.period) > 1440) throw new Error("Period must be between 1 and 1,440 minutes.");
    if (!/^\d+$/.test(positionForm.hours) || Number(positionForm.hours) < 1 || Number(positionForm.hours) > 720) throw new Error("Expiry must be between 1 and 720 hours.");
    const start = BigInt((await rpc<{ timestamp: Hex }>("eth_getBlockByNumber", ["latest", false], app.network.id)).timestamp);
    const policy = { buyToken: config.contracts.asset, schedule: start | (BigInt(positionForm.period) * 60n << 64n) | ((start + BigInt(positionForm.hours) * 3600n) << 96n),
      periodBudget, totalBudget, buyUnits: 10n ** 18n, spendUnits, salt: keccak256(crypto.getRandomValues(new Uint8Array(32))) };
    const order = await publicClient.readContract({ address: config.contracts.router, abi: swapAbi, functionName: "buildOrder", args: [account.address, config.contracts.usd, policy] });
    const orderHash = await publicClient.readContract({ address: config.contracts.router, abi: swapAbi, functionName: "hash", args: [order] });
    const encoded = encodeAbiParameters(parseAbiParameters("(address maker, uint256 traits, bytes data)"), [order]);
    const position: Position = { name: positionForm.name.trim().slice(0, 60) || "Recurring buy", order: { ...order, traits: order.traits.toString() }, orderHash,
      policy: { ...policy, schedule: policy.schedule.toString(), periodBudget: String(periodBudget), totalBudget: String(totalBudget), buyUnits: String(policy.buyUnits), spendUnits: String(spendUnits) } };
    await app.prepare({ title: "Create recurring buy", details: [["Total budget", `${positionForm.budget} fpUSD`], ["Per period", `${positionForm.perPeriod} fpUSD every ${positionForm.period} min`], ["Buy price", `${positionForm.price} fpUSD per fpASSET`], ["Expiry", `${positionForm.hours} hours`]],
      assertions: ["Period and lifetime budgets enforced on-chain", "Unused period capacity does not carry over", "Funds stay in your account until a taker fills"], sponsored, position,
      calls: [call(config.contracts.usd, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [config.contracts.aqua, totalBudget] })),
        call(config.contracts.aqua, encodeFunctionData({ abi: aquaAbi, functionName: "ship", args: [config.contracts.router, encoded, [config.contracts.asset, config.contracts.usd], [0n, totalBudget]] }))] });
  }
  async function cancelPosition(position: Position) {
    if (!config || position.order.maker.toLowerCase() !== account?.address.toLowerCase()) throw new Error("Only this position’s maker can cancel it.");
    await app.prepare({ title: "Cancel recurring buy", details: [["Position", position.name], ["Effect", "Stop all future fills; tokens remain in your account"]], assertions: ["Only the maker can cancel this position"], sponsored,
      calls: [call(config.contracts.aqua, encodeFunctionData({ abi: aquaAbi, functionName: "dock", args: [config.contracts.router, position.orderHash, [config.contracts.asset, config.contracts.usd]] }))] });
  }
  async function importPosition() {
    if (!config) throw new Error("Local contracts are unavailable.");
    const parsed = JSON.parse(importText) as Position;
    const hash = await publicClient.readContract({ address: config.contracts.router, abi: swapAbi, functionName: "hash", args: [unpackOrder(parsed.order)] });
    if (hash !== parsed.orderHash) throw new Error("Position hash does not match its order.");
    // Rebuild canonical policy to reject misleading metadata or unsupported programs.
    const p = parsed.policy;
    const canonical = await publicClient.readContract({ address: config.contracts.router, abi: swapAbi, functionName: "buildOrder", args: [parsed.order.maker, config.contracts.usd, { buyToken: config.contracts.asset, schedule: BigInt(p.schedule), periodBudget: BigInt(p.periodBudget), totalBudget: BigInt(p.totalBudget), buyUnits: BigInt(p.buyUnits), spendUnits: BigInt(p.spendUnits), salt: p.salt }] });
    const canonicalHash = await publicClient.readContract({ address: config.contracts.router, abi: swapAbi, functionName: "hash", args: [canonical] });
    if (canonicalHash !== hash) throw new Error("This is not a matching FramePay recurring-buy position.");
    await publicClient.readContract({ address: config.contracts.aqua, abi: aquaAbi, functionName: "safeBalances", args: [parsed.order.maker, config.contracts.router, hash, config.contracts.asset, config.contracts.usd] });
    app.savePosition({ ...parsed, name: String(parsed.name).slice(0, 60) }); setImportText(""); app.setNotice("Position imported and verified against Aqua.");
  }
  function saveRules() {
    try { validateRules(ruleDraft); localStorage.setItem(profileKey, JSON.stringify(ruleDraft)); setRules({ ...ruleDraft }); if (ruleDraft.requireSponsor) setSponsored(true); app.setError(""); app.setNotice("Rules saved. They will be checked before your next transaction."); }
    catch (error) { app.setError(error instanceof Error ? error.message : "Could not save rules."); }
  }
  async function fundETH() {
    if (!account) return;
    const result = await rpc<{ txHash: Hex }>("skandha_explorer_faucet", [account.address], app.network.id);
    app.setNotice(`Test ETH requested: ${result.txHash}. Refresh balances after inclusion.`);
    await app.refresh();
  }
  const enabled = !!account && app.ready && !locked && (!app.wallet || app.walletDeployed);
  const titles: Record<Tab, [string, string]> = {
    Swap: ["Trade with a little more control.", "Swap through Aqua. Set your limits. Let the paymaster handle gas."],
    Transfer: ["Send tokens. Keep your ETH.", "Paymaster-sponsored transfers, with your rules checked before funds move."],
    Positions: ["A plan for your next purchase.", "Create recurring buys with fixed prices, spending budgets, and an expiry."],
    Rules: ["Your money. Your conditions.", "Choose what must be true before you sign your next transaction."],
  };
  const ruleRow = (label: string, value: string) => <div className="defi-rule-row"><span className="defi-check"><Icon name="check" size={13} /></span><span>{label}</span><strong>{value}</strong></div>;
  return <div className="defi">
    <header className="defi-header"><Link href="/app" className="defi-brand"><BrandMark /><span>framepay<span className="defi-brand-dot">.</span></span><small>DeFi</small></Link>
      <nav aria-label="DeFi app">{(["Swap", "Transfer", "Positions", "Rules"] as Tab[]).map(item => <button key={item} aria-current={tab === item ? "page" : undefined} className={tab === item ? "active" : ""} disabled={!!app.review} onClick={() => { setTab(item); app.setError(""); }}>{item}</button>)}</nav>
      <div className="defi-header-tools"><Link href="/docs/quickstart" className="defi-docs-link">Docs <Icon name="external" size={12} /></Link><button className="defi-account-button" disabled={locked} onClick={() => account ? void navigator.clipboard.writeText(account.address).then(() => app.setNotice("Account address copied.")) : void app.task(app.createPasskey)}><Icon name="wallet" size={16} />{account ? shortAddress(account.address) : "Create passkey wallet"}</button></div>
    </header>
    <main id="main-content" className="defi-main">
      <div className="defi-intro"><div><p className="defi-eyebrow"><span /> BUILT AROUND YOUR RULES</p><h1>{titles[tab][0]}</h1><p>{titles[tab][1]}</p></div><NetworkBadge /></div>
      {!config && <div className="defi-banner" role="status">The DeFi app is deployed on the local devnet. Select Local devnet to swap, transfer, and manage positions.</div>}
      {app.error && <div className="defi-banner error" role="alert"><Icon name="info" size={18} /><span>{app.error}</span><button onClick={() => app.setError("")} aria-label="Dismiss error"><Icon name="close" size={15} /></button></div>}
      {app.notice && <div className="defi-banner" role="status"><Icon name="info" size={18} /><span>{app.notice}</span><button onClick={() => app.setNotice("")} aria-label="Dismiss notification"><Icon name="close" size={15} /></button></div>}
      {app.pending && <div className="defi-pending"><span className="defi-pulse" /><div><strong>{busy ? "Waiting for confirmation" : "Transaction needs inspection"}</strong><p>{app.pending.title} · {shortAddress(app.pending.hash)}</p></div><a href={`${app.network.id === "local" ? "http://localhost:5173" : "https://explorer.altmempool.wtf"}/tx/${app.pending.hash}`} target="_blank" rel="noreferrer">Explorer ↗</a><button disabled={busy} onClick={() => void app.inspect()}>Inspect receipt</button></div>}
      <section className="defi-balances" aria-label="Account balances">
        <div><Token /><span><small>Available dollars</small><strong>{account ? display(balances.usd) : "—"} <em>fpUSD</em></strong></span></div>
        <div><Token asset /><span><small>Available asset</small><strong>{account ? display(balances.asset, 18) : "—"} <em>fpASSET</em></strong></span></div>
        <div><span className="defi-gas-icon"><Icon name="bolt" /></span><span><small>Gas payment</small><strong>{sponsored ? "Sponsored" : "Self-paid"} <em>{sponsored ? "by FramePay" : "with test ETH"}</em></strong></span><button aria-label="Refresh balances" className="defi-icon-button" disabled={busy} onClick={() => void app.refresh()}><Icon name="refresh" size={17} /></button></div>
      </section>
      <div className={`defi-grid ${tab === "Positions" || tab === "Rules" ? "wide" : ""}`}>
        <section key={tab} className="defi-card defi-action-card" tabIndex={0} aria-label={`${tab} panel`}>
          {tab === "Swap" && <><div className="defi-card-top"><h2>Swap</h2><span className="defi-pill">Aqua · SwapVM</span></div>
            <Field label="Liquidity position"><select disabled={locked} value={selected?.orderHash ?? ""} onChange={event => setSelectedHash(event.target.value)}>{positions.map(position => <option key={position.orderHash} value={position.orderHash}>{position.name}</option>)}</select></Field>
            <div className="defi-swap-amounts"><div className="defi-amount-box"><div><label htmlFor="swap-pay">You pay</label><small>Balance: {display(balances.asset, 18)}</small></div><div><input id="swap-pay" value={quote ? display(quote.input, 18) : ""} placeholder={quoting ? "Quoting…" : "0.00"} readOnly /><span><Token asset />fpASSET</span></div></div>
            <div className="defi-flow-arrow" aria-hidden="true">↓</div>
            <div className="defi-amount-box receive"><div><label htmlFor="swap-receive">You receive</label><small>Exact amount</small></div><div><input id="swap-receive" inputMode="decimal" value={receive} onChange={event => setReceive(event.target.value)} disabled={locked} /><span><Token />fpUSD</span></div></div></div>
            <p className="defi-quote-note">{quoting ? "Checking the live position…" : quoteError || (quote ? `1 fpASSET = ${display(BigInt(selected.policy.spendUnits))} fpUSD · fixed position price` : "Connect to the local devnet for a live quote.")}</p>
            <div className="defi-summary-line"><span>Available this period</span><strong>{selectedState ? `${display(selectedState.available)} fpUSD` : "Checking…"}</strong></div>
            <div className="defi-summary-line"><span>Minimum output rule</span><strong>{rules.minimumSwapOutput} fpUSD</strong></div>
            <div className="defi-sponsor-choice"><span><Icon name="bolt" size={16} />Gas paid by</span><select aria-label="Swap gas payer" disabled={locked || rules.requireSponsor || !!app.wallet} value={sponsored ? "sponsor" : "self"} onChange={event => setSponsored(event.target.value === "sponsor")}><option value="sponsor">FramePay paymaster</option><option value="self">My test ETH</option></select></div>
            <button className="defi-primary" disabled={!enabled || !quote || quoting} onClick={() => void app.task(swap)}>{busy ? "Preparing…" : account ? "Review swap" : "Create a wallet to swap"}<Icon name="arrow" size={17} /></button>
            <p className="defi-footnote"><Icon name="check" size={13} />Exact amounts and expiry are checked on-chain.</p>
          </>}
          {tab === "Transfer" && <><div className="defi-card-top"><h2>Send a transfer</h2><span className="defi-pill">Gas sponsorship</span></div>
            <Field label="Recipient" hint={rules.allowedRecipients ? "Only recipients in your saved list are allowed." : "Send to another account on this devnet."}><input placeholder="0x…" spellCheck={false} value={recipient} onChange={event => setRecipient(event.target.value)} disabled={locked} /></Field>
            <div className="defi-amount-box"><div><label htmlFor="transfer-amount">Amount to send</label><small>Balance: {display(transferToken === "eth" ? balances.eth : balances.usd, transferToken === "eth" ? 18 : 6)}</small></div><div><input id="transfer-amount" inputMode="decimal" value={transferAmount} onChange={event => setTransferAmount(event.target.value)} disabled={locked} /><select aria-label="Transfer token" value={transferToken} disabled={locked} onChange={event => { setTransferToken(event.target.value as "usd" | "eth"); setTransferAmount(event.target.value === "eth" ? "0.001" : "5"); }}><option value="usd">fpUSD</option><option value="eth">ETH</option></select></div></div>
            <div className="defi-summary-line"><span>Your transfer cap</span><strong>{transferToken === "eth" ? `${rules.maxNativeTransfer} ETH` : `${rules.maxTokenTransfer} fpUSD`}</strong></div>
            <div className="defi-summary-line"><span>Transaction expires in</span><strong>{rules.deadlineMinutes} minutes</strong></div>
            <div className="defi-sponsor-choice"><span><Icon name="bolt" size={16} />Gas paid by</span><select aria-label="Transfer gas payer" disabled={locked || rules.requireSponsor || !!app.wallet} value={sponsored ? "sponsor" : "self"} onChange={event => setSponsored(event.target.value === "sponsor")}><option value="sponsor">FramePay paymaster</option><option value="self">My test ETH</option></select></div>
            <button className="defi-primary" disabled={!enabled} onClick={() => void app.task(transfer)}>{busy ? "Preparing…" : "Review transfer"}<Icon name="arrow" size={17} /></button><p className="defi-footnote">Sponsorship covers gas. Your account supplies the transfer amount.</p>
          </>}
          {tab === "Positions" && <><div className="defi-card-top"><div><h2>Recurring buys</h2><p className="defi-small">A taker fills your position at your chosen price.</p></div><button className="defi-secondary" disabled={locked} onClick={() => setShowCreate(!showCreate)}>{showCreate ? "Close" : "+ Create"}</button></div>
            {showCreate && <div className="defi-position-form"><Field label="Position name"><input value={positionForm.name} maxLength={60} disabled={locked} onChange={event => setPositionForm({ ...positionForm, name: event.target.value })} /></Field><div className="defi-field-grid">
              {([['budget', 'Total budget (fpUSD)'], ['perPeriod', 'Spend per period (fpUSD)'], ['period', 'Period (minutes)'], ['price', 'Price per fpASSET (fpUSD)'], ['hours', 'Expires after (hours)']] as const).map(([key, label]) => <Field key={key} label={label}><input inputMode="decimal" value={positionForm[key]} disabled={locked} onChange={event => setPositionForm({ ...positionForm, [key]: event.target.value })} /></Field>)}
            </div><p className="defi-small">No unused budget carries over. Limits are fixed once published; cancel and create a new position to change them. Creating another position updates your shared Aqua token allowance to the new budget.</p><button className="defi-primary" disabled={!enabled} onClick={() => void app.task(createPosition)}>Review position<Icon name="arrow" size={17} /></button></div>}
            <div className="defi-position-list">{positions.map(position => {
              const status = positionStates[position.orderHash];
              const own = position.order.maker.toLowerCase() === account?.address.toLowerCase();
              const expired = status && status.expiry <= clock / 1000;
              return <article key={position.orderHash} className="defi-position"><div className="defi-card-top"><div><h3>{position.name}</h3><small>{own ? "Your position" : `Maker ${shortAddress(position.order.maker)}`}</small></div><span className={`defi-pill ${status?.inactive || expired ? "muted" : ""}`}>{!status ? "Checking…" : status.inactive ? "Not active" : expired ? "Expired" : status.available === 0n ? "At limit" : "Active"}</span></div><div className="defi-position-metrics"><span><small>Per period</small><strong>{display(BigInt(position.policy.periodBudget))} fpUSD</strong></span><span><small>Total filled</small><strong>{status ? display(status.totalSpent) : "—"} / {display(BigInt(position.policy.totalBudget))}</strong></span><span><small>Available now</small><strong>{status ? display(status.available) : "—"} fpUSD</strong></span></div>
                <div className="defi-position-bottom"><small>{status ? `Expires ${new Date(status.expiry * 1000).toLocaleString()}` : "Reading on-chain status…"}</small><div><button className="defi-text-button" onClick={() => void navigator.clipboard.writeText(JSON.stringify(position)).then(() => app.setNotice("Position copied. Another account can import it to fill your order."))}>Share</button>{own ? <button className="defi-text-button danger" disabled={!enabled || status?.inactive} onClick={() => void app.task(() => cancelPosition(position))}>Cancel position</button> : <button className="defi-text-button" disabled={locked} onClick={() => { setSelectedHash(position.orderHash); setTab("Swap"); }}>Swap ↗</button>}</div></div></article>;
            })}</div>
            <details className="defi-import"><summary>Import a shared position</summary><Field label="Position JSON"><textarea rows={3} value={importText} disabled={locked} onChange={event => setImportText(event.target.value)} placeholder="Paste a position shared by another maker" /></Field><button className="defi-secondary" disabled={!app.ready || locked || !importText} onClick={() => void app.task(importPosition)}>Verify & import</button></details>
          </>}
          {tab === "Rules" && <><div className="defi-card-top"><h2>Transaction rules</h2><span className="defi-pill">Saved on this device</span></div><p className="defi-description">These preferences are checked before signing. The app includes amount, price and expiry assertions in the signed contract calls.</p>
            <div className="defi-field-grid defi-rules-fields">{([['maxTokenTransfer', 'Maximum token transfer', 'fpUSD'], ['maxNativeTransfer', 'Maximum ETH transfer', 'ETH'], ['maxSwapInput', 'Maximum swap input', 'fpASSET'], ['minimumSwapOutput', 'Minimum swap output', 'fpUSD'], ['deadlineMinutes', 'Transaction expiry', 'minutes · 1–60']] as const).map(([key, label, hint]) => <Field key={key} label={label} hint={hint}><input inputMode="decimal" value={ruleDraft[key]} disabled={locked} onChange={event => setRuleDraft({ ...ruleDraft, [key]: event.target.value })} /></Field>)}</div>
            <Field label="Allowed recipients" hint="Optional. Separate addresses with commas. Checked by this app before signing; this does not install a permanent wallet permission."><textarea rows={3} placeholder="Any valid recipient when empty" value={ruleDraft.allowedRecipients} disabled={locked} onChange={event => setRuleDraft({ ...ruleDraft, allowedRecipients: event.target.value })} /></Field>
            <label className="defi-toggle-row"><span><strong>Require gas sponsorship</strong><small>Prevent this app from preparing self-paid transactions.</small></span><input type="checkbox" role="switch" checked={ruleDraft.requireSponsor} disabled={locked} onChange={event => setRuleDraft({ ...ruleDraft, requireSponsor: event.target.checked })} /></label>
            <button className="defi-primary" disabled={locked} onClick={saveRules}>Save rules<Icon name="check" size={17} /></button><p className="defi-footnote">Recurring position budgets are managed separately in Positions.</p>
          </>}
        </section>
        <aside className="defi-aside" tabIndex={0} aria-label="Account and transaction assertions"><section className="defi-card defi-rules-card"><div className="defi-card-top"><span className="defi-outline-icon"><Icon name="layers" size={19} /></span><span className="defi-eyebrow">ASSERTIONS</span></div><h2>Before anything moves.</h2><p>Your saved checks travel with your next transaction.</p>
          {ruleRow("Transfer cap", `${rules.maxTokenTransfer} fpUSD`)}{ruleRow("Swap input cap", `${rules.maxSwapInput} fpASSET`)}{ruleRow("Minimum output", `${rules.minimumSwapOutput} fpUSD`)}{ruleRow("Expiry", `${rules.deadlineMinutes} min`)}{ruleRow("Gas sponsorship", rules.requireSponsor ? "Required" : "Optional")}
          <button className="defi-text-button" disabled={locked} onClick={() => setTab("Rules")}>Manage your rules <Icon name="arrow" size={15} /></button>
        </section><section className="defi-card defi-wallet-card"><div className="defi-card-top"><h3>{app.wallet ? "Your passkey wallet" : "Your account"}</h3><Icon name="wallet" size={19} /></div>
          {app.wallet && <span className="defi-pill">{app.walletDeployed ? "Passkey · verified onchain" : "Ready to deploy"}</span>}
          {account ? <><code title={account.address}>{shortAddress(account.address)}</code><p>Available test ETH: {display(balances.eth, 18)}</p><div className="defi-wallet-actions">
            {app.wallet && !app.walletDeployed ? <button className="defi-secondary" disabled={!app.ready || locked} onClick={() => void app.task(app.deployWallet)}>Deploy wallet</button> : <button className="defi-secondary" disabled={!enabled || (app.claimed.usd && app.claimed.asset)} onClick={() => void app.task(claimTokens)}>{app.claimed.usd && app.claimed.asset ? "Test tokens claimed" : "Get test tokens"}</button>}
            <button className="defi-text-button" disabled={!enabled} onClick={() => void app.task(fundETH)}>Get test ETH</button><button className="defi-text-button" onClick={app.exportAccount}>{app.wallet ? "Export wallet metadata" : "Export test account"}</button>
            {!app.wallet && <button className="defi-text-button" disabled={locked || !app.ready} onClick={() => void app.task(app.createPasskey)}>Create passkey wallet</button>}
          </div><small>{app.wallet ? `Approve each transaction with your passkey at ${app.wallet.origin}. Public wallet metadata is saved on this device. Keep access to your passkey; recovery is not configured.` : "The test key is stored in this tab. Export it before closing. Creating a passkey wallet gives you a separate account."}</small></> : <><p>Create a smart wallet with your passkey. Your wallet verifies each approval onchain.</p><button className="defi-secondary" disabled={locked || !app.ready} onClick={() => void app.task(app.createPasskey)}>Create passkey wallet</button><button className="defi-text-button" disabled={locked} onClick={app.createAccount}>Use a disposable test account</button><small>Local devnet assets have no real value. Your passkey provider manages the wallet's private key.</small></>}
          <input ref={accountFile} type="file" accept="application/json,.json" hidden aria-label="Wallet or test account export file" onChange={event => { const file = event.target.files?.[0]; if (file) void file.text().then(app.importAccount); event.target.value = ""; }} /><button className="defi-text-button" disabled={locked} onClick={() => accountFile.current?.click()}>Import wallet / test account</button>
        </section><div className="defi-powered"><span className="defi-tiny-dot" /> Native frames. Official Aqua settlement.</div></aside>
      </div>
      <details className="defi-activity"><summary><span>Recent activity</span><span>{app.activity.length} transactions <span className="defi-activity-chevron" aria-hidden="true">⌄</span></span></summary><div className="defi-activity-content">{app.activity.length ? <div className="defi-activity-table">{app.activity.map(item => <div key={item.hash}><span className={`defi-activity-icon ${item.status}`}><Icon name={item.status === "confirmed" ? "check" : item.status === "failed" ? "close" : "refresh"} size={16} /></span><span><strong>{item.title}</strong><small>{new Date(item.at).toLocaleString()}</small></span><span className={`defi-status ${item.status}`}>{item.status === "pending" ? "Needs confirmation" : item.status}</span><a href={`${app.network.id === "local" ? "http://localhost:5173" : "https://explorer.altmempool.wtf"}/tx/${item.hash}`} target="_blank" rel="noreferrer">{shortAddress(item.hash)} <Icon name="external" size={13} /></a></div>)}</div> : <div className="defi-empty"><span><Icon name="layers" size={22} /></span><div><strong>Your next move starts here.</strong><p>Confirmed swaps and transfers will appear in this space.</p></div></div>}</div></details>
      <footer className="defi-footer"><span>FramePay · Local devnet preview</span><span>{app.wallet ? "Test assets only · Passkey authorization" : "Test assets only · EOA authorization"}</span><Link href="/playground">Developer playground ↗</Link></footer>
    </main>
    {app.review && <ReviewModal review={app.review} busy={busy} confirm={() => void app.confirm()} cancel={() => app.setReview(null)} />}
  </div>;
}
