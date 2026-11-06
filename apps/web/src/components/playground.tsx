"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { formatEther, isAddress, parseEther, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import {
  frame,
  getProfile,
  privateKeyToFrameSigner,
  txHash,
  FramePayError,
  type FrameTx,
  type FrameSigner,
  type FrameReceipt,
  type FrameAdmission,
} from "@framepay/sdk";
import { frameClient, rpc, jsonText, shortAddress } from "@/lib/rpc";
import { useNetwork } from "./network";
import { Icon } from "./icon";

type Stage =
  | "idle"
  | "preparing"
  | "prepared"
  | "signing"
  | "signed"
  | "submitting"
  | "pending"
  | "confirmed"
  | "failed"
  | "uncertain";
type Event = { time: string; text: string; kind: "info" | "success" | "error" };
const profile = getProfile("ethrex-eip8141-tracer");
const emptyMessage: Record<string, string> = {
  payload: "Prepare a transaction to inspect its frame envelope.",
  receipt:
    "A mined transaction will show its per-frame execution results here.",
  admission:
    "Submit or look up a transaction to read the sidecar’s admission checks.",
};
const stageLabel: Record<Stage, string> = {
  idle: "Draft",
  preparing: "Preparing",
  prepared: "Prepared",
  signing: "Signing",
  signed: "Signed locally",
  submitting: "Submitting",
  pending: "Waiting for inclusion",
  confirmed: "Executed",
  failed: "Execution failed",
  uncertain: "Needs inspection",
};

function errorText(error: unknown) {
  return error instanceof Error
    ? error.message.slice(0, 400)
    : "The action failed. Check the gateway and try the read-only inspection.";
}
function copy(value: string) {
  return navigator.clipboard.writeText(value);
}

export function Playground() {
  const network = useNetwork();
  const signer = useRef<FrameSigner | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<"compose" | "inspect">("compose");
  const [address, setAddress] = useState<Hex | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [funding, setFunding] = useState(false);
  const [faucetHash, setFaucetHash] = useState<Hex | null>(null);
  const [recipient, setRecipient] = useState(
    "0x8943545177806ED17B9F23F0a21ee5948eCaa776"
  );
  const [amount, setAmount] = useState("0.000000001");
  const [stage, setStage] = useState<Stage>("idle");
  const [transaction, setTransaction] = useState<FrameTx | null>(null);
  const [signed, setSigned] = useState<FrameTx | null>(null);
  const [hash, setHash] = useState<Hex | null>(null);
  const [receipt, setReceipt] = useState<FrameReceipt | null>(null);
  const [admission, setAdmission] = useState<FrameAdmission | null>(null);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<Event[]>([]);
  const [tab, setTab] = useState<"payload" | "receipt" | "admission">(
    "payload"
  );
  const [lookupHash, setLookupHash] = useState("");
  const [lookup, setLookup] = useState<{
    hash: Hex;
    receipt: FrameReceipt | null;
    admission: FrameAdmission | null;
  } | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupMessage, setLookupMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const busy =
    ["preparing", "signing", "submitting", "pending"].includes(stage) ||
    funding;
  const locked = stage !== "idle";
  const connected = network.status === "online";
  const displayReceipt = mode === "inspect" ? lookup?.receipt ?? null : receipt;
  const displayAdmission =
    mode === "inspect" ? lookup?.admission ?? null : admission;
  const displayHash = mode === "inspect" ? lookup?.hash : hash;
  const displayValue =
    tab === "payload"
      ? mode === "compose"
        ? signed ?? transaction
        : null
      : tab === "receipt"
      ? displayReceipt
      : displayAdmission;
  const log = (text: string, kind: Event["kind"] = "info") =>
    setEvents((items) => [
      ...items.slice(-19),
      {
        time: new Date().toLocaleTimeString("en-GB", { hour12: false }),
        text,
        kind,
      },
    ]);

  async function refreshBalance(account = address) {
    if (!account) return;
    try {
      setBalance(BigInt(await rpc<Hex>("eth_getBalance", [account, "latest"])));
    } catch {
      setBalance(null);
    }
  }
  function createAccount() {
    signer.current = privateKeyToFrameSigner(generatePrivateKey());
    setAddress(signer.current.address);
    setBalance(null);
    setFaucetHash(null);
    setError("");
    log(
      "Disposable account created. Its key stays in this page’s memory.",
      "success"
    );
    void refreshBalance(signer.current.address);
  }
  async function fund() {
    if (!address) return;
    setFunding(true);
    setError("");
    try {
      const funded = await rpc<{ txHash: Hex }>("skandha_explorer_faucet", [
        address,
      ]);
      if (!/^0x[\da-fA-F]{64}$/.test(funded.txHash))
        throw new Error("The faucet returned an invalid transaction hash.");
      setFaucetHash(funded.txHash);
      log("Faucet transfer requested. Waiting for its receipt.");
      const end = Date.now() + 120_000;
      while (Date.now() < end) {
        const result = await rpc<{ status: string } | null>(
          "eth_getTransactionReceipt",
          [funded.txHash]
        );
        if (result) {
          if (result.status !== "0x1")
            throw new Error("The faucet transfer reverted.");
          await refreshBalance();
          log("Faucet transfer included. Test account is funded.", "success");
          return;
        }
        await new Promise((done) => setTimeout(done, 2_000));
      }
      throw new Error(
        "Faucet receipt timed out. Check the funding hash before requesting again."
      );
    } catch (err) {
      setError(errorText(err));
      log(errorText(err), "error");
    } finally {
      setFunding(false);
    }
  }
  async function readAdmission(
    client: ReturnType<typeof frameClient>,
    target: Hex
  ) {
    try {
      const result = await client.getFrameAdmission({ hash: target });
      setAdmission(result);
    } catch {
      log(
        "Admission history is unavailable. The receipt result is independent of retained history."
      );
    }
  }
  async function primaryAction() {
    if (!signer.current) return;
    const client = frameClient();
    setError("");
    try {
      if (stage === "idle") {
        if (!isAddress(recipient))
          throw new Error("Enter a valid recipient address.");
        let value;
        try {
          value = parseEther(amount);
        } catch {
          throw new Error("Enter a valid ETH amount.");
        }
        if (value <= 0n || value > parseEther("0.001"))
          throw new Error(
            "Use an amount greater than zero and at most 0.001 test ETH."
          );
        setStage("preparing");
        const prepared = await client.prepareFrameTransaction({
          sender: signer.current.address,
          maxFeePerGas: 2_000_000_000n,
          frames: [
            frame(profile, "VERIFY", {
              scope: "EXECUTION_AND_PAYMENT",
              execution: 30_000n,
            }),
            frame(profile, "SENDER", {
              target: recipient,
              value,
              execution: 50_000n,
              state: 200_000n,
            }),
          ],
        });
        setTransaction(prepared);
        setStage("prepared");
        setTab("payload");
        log(
          `Transaction prepared with nonce ${prepared.nonceSeq}. No transaction has been sent.`,
          "success"
        );
      } else if (stage === "prepared" && transaction) {
        setStage("signing");
        const result = await client.signFrameTransaction({
          transaction,
          signer: signer.current,
        });
        setSigned(result);
        setStage("signed");
        log(
          "Envelope signed locally. Ready for explicit submission.",
          "success"
        );
      } else if (stage === "signed" && signed) {
        const expected = txHash(profile, signed);
        setHash(expected);
        setStage("submitting");
        log(
          `Submitting ${shortAddress(expected)} to the standard alt-mempool.`
        );
        const submitted = await client.sendFrameTransaction({
          transaction: signed,
        });
        setHash(submitted);
        setStage("pending");
        setTab("receipt");
        log(
          "Gateway acknowledged the transaction hash. Waiting for execution."
        );
        abort.current = new AbortController();
        const result = await client.waitForFrameReceipt({
          hash: submitted,
          expectedFrameCount: 2,
          signal: abort.current.signal,
        });
        setReceipt(result);
        setStage("confirmed");
        log(
          `Both frames succeeded in block ${BigInt(result.blockNumber)}.`,
          "success"
        );
        await readAdmission(client, submitted);
        await refreshBalance();
      }
    } catch (err) {
      setError(errorText(err));
      log(errorText(err), "error");
      if (stage === "signed") {
        setStage(
          err instanceof FramePayError && err.code === "FRAME_REVERTED"
            ? "failed"
            : "uncertain"
        );
        const target = signed ? txHash(profile, signed) : null;
        if (target) {
          await readAdmission(client, target);
          try {
            setReceipt(await client.getFrameReceipt({ hash: target }));
          } catch {
            /* preserve uncertainty */
          }
        }
      } else {
        setStage(stage === "prepared" ? "prepared" : "idle");
      }
    }
  }
  async function inspectCurrent() {
    if (!hash) return;
    setError("");
    setLookupBusy(true);
    try {
      const client = frameClient();
      const result = await client.getFrameReceipt({ hash });
      setReceipt(result);
      setTab("receipt");
      if (result) {
        const ok =
          result.status === "0x1" &&
          result.frameReceipts.every((item) => item.status === "0x1");
        setStage(ok ? "confirmed" : "failed");
        log(
          ok
            ? "Successful frame execution confirmed."
            : "A transaction or frame failure was confirmed.",
          ok ? "success" : "error"
        );
      } else {
        log("No receipt returned yet. This does not prove rejection.");
      }
      await readAdmission(client, hash);
      await refreshBalance();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLookupBusy(false);
    }
  }
  async function lookUp() {
    if (!/^0x[\da-fA-F]{64}$/.test(lookupHash.trim())) {
      setLookupMessage("Enter a 32-byte transaction hash.");
      return;
    }
    const target = lookupHash.trim() as Hex;
    setLookupBusy(true);
    setLookupMessage("");
    setLookup(null);
    try {
      const client = frameClient();
      const result = await client.getFrameReceipt({ hash: target });
      let admitted = null;
      try {
        admitted = await client.getFrameAdmission({ hash: target });
      } catch {
        setLookupMessage(
          "Admission history could not be retrieved. The receipt result is shown independently."
        );
      }
      setLookup({ hash: target, receipt: result, admission: admitted });
      setTab("receipt");
      if (!result)
        setLookupMessage(
          "No receipt returned. The transaction may be pending or unknown to this gateway."
        );
    } catch (err) {
      setLookupMessage(errorText(err));
    } finally {
      setLookupBusy(false);
    }
  }
  function resetDraft() {
    setStage("idle");
    setTransaction(null);
    setSigned(null);
    setHash(null);
    setReceipt(null);
    setAdmission(null);
    setError("");
    setTab("payload");
  }
  function download() {
    const result = {
      chainId: 1337,
      profile: profile.id,
      observedAt: new Date().toISOString(),
      hash: displayHash,
      receipt: displayReceipt,
      admission: displayAdmission,
    };
    const url = URL.createObjectURL(
      new Blob([jsonText(result)], { type: "application/json" })
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `framepay-${displayHash?.slice(0, 10) ?? "result"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  async function copyOutput() {
    if (!displayValue) return;
    try {
      await copy(jsonText(displayValue));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(
        "Clipboard access is unavailable. Select the output to copy it."
      );
    }
  }
  const primaryLabel =
    stage === "idle"
      ? "Prepare transaction"
      : stage === "prepared"
      ? "Sign locally"
      : stage === "signed"
      ? "Submit to devnet"
      : stageLabel[stage];

  return (
    <main id="main-content" className="playground-page">
      <div className="playground-heading">
        <div>
          <div className="eyebrow">
            <span className="eyebrow-line" />
            THE FRAMEPAY LAB
          </div>
          <h1>Your first frame, live.</h1>
          <p>
            Explore the SDK one action at a time. Every result comes from your
            local devnet.
          </p>
        </div>
        <Link className="button secondary" href="/docs/quickstart">
          <Icon name="book" size={16} />
          Read the guide
        </Link>
      </div>
      <div className="playground-toolbar">
        <div className="segmented" aria-label="Playground mode">
          <button
            className={mode === "compose" ? "selected" : ""}
            disabled={busy}
            onClick={() => setMode("compose")}
          >
            <Icon name="code" size={15} />
            Compose transaction
          </button>
          <button
            className={mode === "inspect" ? "selected" : ""}
            disabled={busy}
            onClick={() => setMode("inspect")}
          >
            <Icon name="search" size={15} />
            Inspect a hash
          </button>
        </div>
        <div className="playground-network">
          <span className={`status-dot ${connected ? "online" : ""}`} />
          <span>
            {connected ? `Block ${network.block}` : "Gateway not connected"}
          </span>
          <button
            className="icon-button"
            aria-label="Refresh connection"
            onClick={() => void network.refresh()}
          >
            <Icon name="refresh" size={14} />
          </button>
        </div>
      </div>
      {!connected && (
        <div className="connection-banner">
          <Icon name="info" size={18} />
          <span>
            {network.status === "wrong-chain"
              ? "The gateway is on a different chain. This playground requires chain 1337."
              : "Connect your local devnet at localhost:14337 to run a transaction. You can still browse the SDK docs and create a test account."}
          </span>
          <button onClick={() => void network.refresh()}>
            Check connection <Icon name="refresh" size={13} />
          </button>
        </div>
      )}
      <div className="playground-grid">
        <section className="composer panel">
          <div className="panel-heading">
            <span>
              <Icon name={mode === "compose" ? "code" : "search"} size={17} />
              {mode === "compose"
                ? "Transaction composer"
                : "Transaction lookup"}
            </span>
            <span className="subtle-badge">LOCAL DEVNET</span>
          </div>
          {mode === "compose" ? (
            <>
              <div className="form-section">
                <div className="form-section-title">
                  <span className="inline-number">01</span>
                  <h2>Test account</h2>
                  <span className="subtle-badge">SECP256K1</span>
                </div>
                {!address ? (
                  <>
                    <p>
                      Create a disposable signer to try the full transaction
                      flow.
                    </p>
                    <button
                      className="button account-button"
                      onClick={createAccount}
                    >
                      <Icon name="key" size={16} />
                      Create test account
                      <Icon name="arrow" size={15} />
                    </button>
                  </>
                ) : (
                  <div className="account-box">
                    <div>
                      <span className="account-avatar">
                        <Icon name="wallet" size={18} />
                      </span>
                      <span>
                        <small>YOUR TEST ACCOUNT</small>
                        <strong title={address}>{shortAddress(address)}</strong>
                      </span>
                      <button
                        className="icon-button"
                        aria-label="Copy account address"
                        onClick={() =>
                          void copy(address).catch(() =>
                            setError("Clipboard access is unavailable.")
                          )
                        }
                      >
                        <Icon name="copy" size={14} />
                      </button>
                    </div>
                    <div className="balance-row">
                      <span>Balance</span>
                      <strong>
                        {balance === null
                          ? "—"
                          : `${Number(formatEther(balance)).toFixed(6)} ETH`}
                      </strong>
                      <button
                        className="icon-button"
                        aria-label="Refresh account balance"
                        onClick={() => void refreshBalance()}
                      >
                        <Icon name="refresh" size={13} />
                      </button>
                    </div>
                  </div>
                )}
                <div className="account-actions">
                  <button
                    className="text-button"
                    disabled={!address || !connected || busy || !!faucetHash}
                    onClick={() => void fund()}
                  >
                    <Icon
                      name={funding ? "refresh" : "bolt"}
                      size={14}
                      className={funding ? "spin" : ""}
                    />
                    {funding
                      ? "Waiting for funding…"
                      : faucetHash
                      ? "Funding requested"
                      : "Get test ETH from faucet"}
                  </button>
                  {address && !locked && (
                    <button
                      className="text-button muted"
                      disabled={busy}
                      onClick={createAccount}
                    >
                      New account
                    </button>
                  )}
                </div>
                <p className="field-hint">
                  The key stays in this page’s memory. Leaving or reloading
                  clears it. Use test funds only.
                </p>
                {faucetHash && (
                  <p className="field-hint mono break-word">
                    Funding tx: {faucetHash}
                  </p>
                )}
              </div>
              <div className="form-section">
                <div className="form-section-title">
                  <span className="inline-number">02</span>
                  <h2>Transfer details</h2>
                  <span className="subtle-badge">SELF-PAID</span>
                </div>
                <label htmlFor="recipient">Recipient address</label>
                <input
                  id="recipient"
                  className="text-input mono"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  disabled={locked}
                  spellCheck={false}
                  autoComplete="off"
                />
                <label htmlFor="amount">Amount</label>
                <div className="amount-input">
                  <input
                    id="amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    disabled={locked}
                    inputMode="decimal"
                    autoComplete="off"
                  />
                  <span>ETH</span>
                </div>
                <div className="fee-row">
                  <span>
                    Max gas price <Icon name="info" size={12} />
                  </span>
                  <strong>2 gwei</strong>
                </div>
                <div className="fee-row">
                  <span>Chain ID</span>
                  <code>1337</code>
                </div>
                <p className="field-hint">
                  Maximum transfer: 0.001 test ETH. Explicit workshop gas
                  limits; no automatic gas estimation.
                </p>
              </div>
              <div className="composer-action">
                {error && (
                  <div className="inline-error" role="alert">
                    <Icon name="info" size={16} />
                    {error}
                  </div>
                )}
                {[
                  "idle",
                  "preparing",
                  "prepared",
                  "signing",
                  "signed",
                  "submitting",
                  "pending",
                ].includes(stage) ? (
                  <button
                    className="button primary full-width"
                    disabled={
                      !address ||
                      busy ||
                      ((stage === "idle" || stage === "signed") &&
                        !connected) ||
                      (stage === "idle" && (balance === null || balance === 0n))
                    }
                    onClick={() => void primaryAction()}
                  >
                    <Icon
                      name={
                        busy
                          ? "refresh"
                          : stage === "prepared"
                          ? "key"
                          : "arrow"
                      }
                      size={16}
                      className={busy ? "spin" : ""}
                    />
                    {primaryLabel}
                  </button>
                ) : stage === "uncertain" ? (
                  <button
                    className="button primary full-width"
                    disabled={lookupBusy || !connected}
                    onClick={() => void inspectCurrent()}
                  >
                    <Icon name="search" size={16} />
                    {lookupBusy
                      ? "Checking…"
                      : "Check receipt — no resubmission"}
                  </button>
                ) : (
                  <button
                    className="button primary full-width"
                    onClick={resetDraft}
                  >
                    Prepare another transaction <Icon name="arrow" size={16} />
                  </button>
                )}
                {stage === "pending" && (
                  <button
                    className="text-button centered"
                    onClick={() => abort.current?.abort()}
                  >
                    Stop waiting
                  </button>
                )}
                {["prepared", "signed"].includes(stage) && (
                  <button className="text-button centered" onClick={resetDraft}>
                    Reset draft
                  </button>
                )}
                <p className="action-note">
                  {!address
                    ? "Start by creating a test account."
                    : balance === 0n
                    ? "Fund the account before preparing a transaction."
                    : stage === "signed"
                    ? "The next action sends a real transaction to your local chain."
                    : stage === "uncertain"
                    ? "The transaction may already be accepted. Inspect its hash before sending again."
                    : "Prepare and sign first. Submit only when you’re ready."}
                </p>
              </div>
            </>
          ) : (
            <div className="lookup-form">
              <span className="feature-icon">
                <Icon name="search" size={21} />
              </span>
              <h2>Follow a transaction.</h2>
              <p>
                Look up a frame transaction through the same gateway. No account
                or signature is needed.
              </p>
              <label htmlFor="lookup-hash">Transaction hash</label>
              <input
                id="lookup-hash"
                className="text-input mono"
                placeholder="0x…"
                value={lookupHash}
                onChange={(e) => setLookupHash(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                className="button primary full-width"
                disabled={!connected || lookupBusy}
                onClick={() => void lookUp()}
              >
                <Icon
                  name={lookupBusy ? "refresh" : "search"}
                  className={lookupBusy ? "spin" : ""}
                  size={16}
                />
                {lookupBusy ? "Looking up…" : "Inspect transaction"}
              </button>
              {lookupMessage && (
                <p className="lookup-message" role="status">
                  {lookupMessage}
                </p>
              )}
              <div className="lookup-tip">
                <Icon name="info" size={16} />
                <p>
                  Receipts describe execution. Admission reports describe the
                  sidecar’s decision. Retained admission history can disappear
                  after a restart.
                </p>
              </div>
            </div>
          )}
        </section>
        <div className="inspector-column">
          <section className="panel inspector">
            <div className="panel-heading">
              <span>
                <Icon name="layers" size={17} />
                Execution inspector
              </span>
              <span
                className={`stage-badge ${
                  stage === "confirmed" && mode === "compose" ? "success" : ""
                }`}
              >
                {mode === "compose"
                  ? stageLabel[stage]
                  : lookup
                  ? "Read-only result"
                  : "Awaiting hash"}
              </span>
            </div>
            <div className="frame-preview">
              {mode === "compose" || displayReceipt ? (
                (mode === "compose"
                  ? [0, 1]
                  : displayReceipt!.frameReceipts.map((_, index) => index)
                ).map((index) => (
                  <div
                    className={`frame-preview-item ${
                      displayReceipt?.frameReceipts[index]?.status === "0x1"
                        ? "executed"
                        : displayReceipt?.frameReceipts[index]?.status === "0x0"
                        ? "reverted"
                        : ""
                    }`}
                    key={index}
                  >
                    <div className="frame-index">
                      {displayReceipt?.frameReceipts[index] ? (
                        <Icon
                          name={
                            displayReceipt.frameReceipts[index].status === "0x1"
                              ? "check"
                              : "close"
                          }
                          size={14}
                        />
                      ) : (
                        `0${index + 1}`
                      )}
                    </div>
                    <div>
                      <strong>
                        {mode === "inspect"
                          ? `FRAME ${index + 1}`
                          : index === 0
                          ? "VERIFY"
                          : "SENDER"}
                      </strong>
                      <p>
                        {mode === "inspect"
                          ? "Recorded execution result"
                          : index === 0
                          ? "Authorize execution & payment"
                          : "Execute the transfer"}
                      </p>
                    </div>
                    <span>
                      {displayReceipt?.frameReceipts[index]?.status === "0x1"
                        ? "SUCCESS"
                        : displayReceipt?.frameReceipts[index]?.status === "0x0"
                        ? "REVERTED"
                        : transaction && mode === "compose"
                        ? "PREPARED"
                        : "DRAFT"}
                    </span>
                  </div>
                ))
              ) : (
                <div className="frame-lookup-empty">
                  <Icon name="layers" size={20} />
                  Frame results appear after a successful lookup.
                </div>
              )}
            </div>
            {displayHash && (
              <div className="transaction-hash">
                <span>TX HASH</span>
                <code>{displayHash}</code>
                <button
                  className="icon-button"
                  aria-label="Copy transaction hash"
                  onClick={() =>
                    void copy(displayHash).catch(() =>
                      setError("Clipboard access is unavailable.")
                    )
                  }
                >
                  <Icon name="copy" size={13} />
                </button>
              </div>
            )}
            <div className="inspector-tabs">
              <div role="tablist" aria-label="Transaction output">
                {(["payload", "receipt", "admission"] as const).map((item) => (
                  <button
                    role="tab"
                    aria-selected={tab === item}
                    aria-controls="inspector-output"
                    id={`tab-${item}`}
                    key={item}
                    className={tab === item ? "selected" : ""}
                    onClick={() => setTab(item)}
                  >
                    {item === "payload"
                      ? "Payload"
                      : item === "receipt"
                      ? "Receipt"
                      : "Admission"}
                    {item === "receipt" && displayReceipt && (
                      <span className="tab-dot" />
                    )}
                  </button>
                ))}
              </div>
              <button
                className="icon-button"
                disabled={!displayValue}
                onClick={() => void copyOutput()}
                aria-label="Copy inspector output"
              >
                <Icon name={copied ? "check" : "copy"} size={15} />
              </button>
            </div>
            <div
              id="inspector-output"
              role="tabpanel"
              aria-labelledby={`tab-${tab}`}
              className="inspector-output"
            >
              {displayValue ? (
                <pre tabIndex={0}>{jsonText(displayValue)}</pre>
              ) : (
                <div className="empty-output">
                  <span className="empty-output-icon">
                    <Icon
                      name={tab === "admission" ? "search" : "code"}
                      size={25}
                    />
                  </span>
                  <strong>
                    {tab === "payload"
                      ? "Your transaction starts here."
                      : tab === "receipt"
                      ? "Execution leaves a receipt."
                      : "Every admission has a story."}
                  </strong>
                  <p>
                    {mode === "inspect" && tab === "payload"
                      ? "The lookup reads receipts and admission records. Raw payload lookup is not part of this API."
                      : emptyMessage[tab]}
                  </p>
                  <span className="empty-dashes" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              )}
            </div>
            <div className="inspector-footer">
              <span>
                <Icon name="code" size={13} />
                ethrex-eip8141-tracer <span className="type-badge">0x06</span>
              </span>
              <button
                className="text-button"
                disabled={
                  !displayHash || (!displayReceipt && !displayAdmission)
                }
                onClick={download}
              >
                <Icon name="download" size={13} />
                Export result
              </button>
            </div>
          </section>
          <section className="panel event-panel">
            <div className="panel-heading">
              <span>
                <Icon name="terminal" size={16} />
                Session activity
              </span>
              <span className="micro-label">{events.length} EVENTS</span>
            </div>
            <div className="event-list" aria-live="polite">
              {events.length ? (
                events.map((event, i) => (
                  <div className={`event ${event.kind}`} key={i}>
                    <time>{event.time}</time>
                    <span className="status-dot" />
                    <p>{event.text}</p>
                  </div>
                ))
              ) : (
                <div className="event-empty">
                  <span className="console-cursor" />
                  <span>Ready when you are. Actions will appear here.</span>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
      <div className="playground-bottom">
        <span>
          <Icon name="info" size={15} />
          This example uses a self-paid EOA. Paymaster and PQ adapters are not
          enabled.
        </span>
        <Link href="/docs/admission">
          Understand admission <Icon name="arrow" size={14} />
        </Link>
      </div>
    </main>
  );
}
