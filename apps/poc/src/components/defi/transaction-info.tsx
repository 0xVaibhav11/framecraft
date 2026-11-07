"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { frameNetworks, type FrameNetworkId } from "@framepay/sdk";
import { formatEther } from "viem";
import { jsonText, rpc } from "@/lib/rpc";
import { Icon } from "../icon";

type Frame = { mode?: number | string; flags?: number | string; to?: string | null; target?: string | null; gasLimit?: string; stateLimit?: string; limits?: { execution?: string; state?: string }; value?: string; data?: string };
type FrameReceipt = { status?: string; gasUsed?: string; stateGasUsed?: string; logs?: unknown[] };
type Receipt = { transactionHash: string; status: string; type?: string; blockHash?: string; blockNumber?: string; transactionIndex?: string; from?: string; payer?: string; gasUsed?: string; effectiveGasPrice?: string; frameReceipts?: FrameReceipt[]; logs?: unknown[] };
type Transaction = { hash: string; sender?: string; from?: string; nonceSeq?: string; nonce?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string; frames?: Frame[] };
type Admission = { hash?: string; admission?: { txHash?: string; outcome?: string; includer?: string; frames?: Frame[]; checks?: { rule: string; verdict: string; detail?: string; frameIndex?: number }[] }; events?: unknown[] };
type Snapshot = { receipt: Receipt | null; transaction: Transaction | null; admission: Admission | null; height?: string; warnings: string[] };
const quantity = (value: unknown) => { try { return BigInt(String(value)).toString(); } catch { return "—"; } };
const amount = (value?: string) => { try { return `${formatEther(BigInt(value ?? "0"))} ETH`; } catch { return "—"; } };
const numeric = (value: unknown) => { try { return Number(BigInt(String(value))); } catch { return -1; } };
function Raw({ title, value }: { title: string; value: unknown }) {
  return <details className="transaction-raw"><summary>{title}</summary><pre>{jsonText(value)}</pre></details>;
}

/** Reads the selected chain; explorer history is optional and never substitutes for a receipt. */
export function TransactionInfo({ hash, networkId, close }: { hash: string; networkId: FrameNetworkId; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const network = frameNetworks[networkId];
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError("");
    try {
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Invalid transaction hash.");
      const chain = await rpc<string>("eth_chainId", [], networkId);
      if (BigInt(chain) !== BigInt(network.chainId)) throw new Error("The gateway is on a different chain.");
      if ("genesisHash" in network) {
        const genesis = await rpc<{ hash: string }>("eth_getBlockByNumber", ["0x0", false], networkId);
        if (genesis.hash !== network.genesisHash) throw new Error("The gateway genesis does not match this deployment.");
      }
      const results = await Promise.allSettled([
        rpc<Receipt | null>("eth_getTransactionReceipt", [hash], networkId),
        rpc<Transaction | null>("eth_getTransactionByHash", [hash], networkId),
        rpc<Admission>("skandha_explorer_getTransaction", [hash], networkId),
        rpc<string>("eth_blockNumber", [], networkId),
      ] as const);
      if (current !== generation.current) return;
      const [receiptResult, txResult, admissionResult, heightResult] = results;
      if (receiptResult.status === "rejected") throw new Error("Could not read the receipt. Refresh to check again.");
      const receipt = receiptResult.value;
      const transaction = txResult.status === "fulfilled" ? txResult.value : null;
      const admission = admissionResult.status === "fulfilled" ? admissionResult.value : null;
      if ((receipt && receipt.transactionHash?.toLowerCase() !== hash.toLowerCase()) || (transaction && transaction.hash?.toLowerCase() !== hash.toLowerCase()) || (admission && admission.hash?.toLowerCase() !== hash.toLowerCase()))
        throw new Error("The gateway returned data for a different transaction.");
      const warnings = [];
      if (txResult.status === "rejected") warnings.push("Transaction envelope is unavailable; any retained admission frames are shown instead.");
      if (admissionResult.status === "rejected" || !admission?.admission) warnings.push("Admission history is unavailable. Nodes may clear it after a restart; the receipt remains authoritative.");
      setSnapshot({ receipt, transaction, admission, height: heightResult.status === "fulfilled" ? heightResult.value : undefined, warnings });
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : "Unable to inspect transaction."); }
    finally { if (current === generation.current) setLoading(false); }
  }, [hash, network, networkId]);
  useEffect(() => { dialog.current?.showModal(); void refresh(); return () => { generation.current++; }; }, [refresh]);
  const receipt = snapshot?.receipt;
  const tx = snapshot?.transaction;
  const frames = tx?.frames ?? snapshot?.admission?.admission?.frames ?? [];
  const frameResults = receipt?.frameReceipts ?? [];
  const status = receipt ? receipt.status !== "0x1" ? "Reverted" : frameResults.some(f => f.status !== "0x1") ? "Included · frame failure" : "Confirmed" : "No receipt yet";
  const explorer = new URL(`/tx/${hash}`, network.explorerUrl ?? frameNetworks.public.explorerUrl);
  explorer.searchParams.set("node", network.rpcUrl);
  return <dialog ref={dialog} className="transaction-dialog" aria-labelledby="transaction-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="defi-card-top"><div><span className="defi-eyebrow">{network.name} · {network.chainId}</span><h2 id="transaction-title">Transaction info</h2></div><button aria-label="Close transaction info" className="defi-icon-button" onClick={close}><Icon name="close" /></button></header>
    <div className="transaction-hash"><code>{hash}</code><button className="defi-text-button" onClick={() => void navigator.clipboard.writeText(hash).then(() => setCopied(true)).catch(() => setError("Could not copy the hash."))}>{copied ? "Copied" : "Copy hash"}</button></div>
    <div className="transaction-actions"><strong>{loading ? "Reading chain…" : error ? "Inspection unavailable" : status}</strong><button className="defi-secondary" disabled={loading} onClick={() => void refresh()}>Refresh</button><a href={explorer.href} target="_blank" rel="noreferrer">Open explorer ↗</a></div>
    {error && <p role="alert" className="defi-banner error">{error}</p>}
    {snapshot && !error && <>
      {!receipt && <p className="defi-small">Inclusion has not been observed. This does not prove rejection; inspect before resubmitting.</p>}
      <dl className="transaction-facts">
        <div><dt>Gateway</dt><dd>{network.rpcUrl}</dd></div>
        <div><dt>Block</dt><dd>{quantity(receipt?.blockNumber)}</dd></div>
        <div><dt>Block hash</dt><dd>{receipt?.blockHash ?? "—"}</dd></div>
        <div><dt>Confirmations</dt><dd>{receipt?.blockNumber && snapshot.height ? String(Math.max(0, numeric(snapshot.height) - numeric(receipt.blockNumber) + 1)) : "—"}</dd></div>
        <div><dt>Sender</dt><dd>{tx?.sender ?? tx?.from ?? receipt?.from ?? "—"}</dd></div>
        <div><dt>Gas payer</dt><dd>{receipt?.payer ?? "Not available until included"}</dd></div>
        <div><dt>Nonce</dt><dd>{quantity(tx?.nonceSeq ?? tx?.nonce)}</dd></div>
        <div><dt>Transaction index</dt><dd>{quantity(receipt?.transactionIndex)}</dd></div>
        <div><dt>Includer</dt><dd>{snapshot.admission?.admission?.includer ?? "Not retained by the sidecar"}</dd></div>
        <div><dt>Transaction type</dt><dd>{receipt?.type ?? "—"}</dd></div>
        <div><dt>Fee cap / priority cap</dt><dd>{quantity(tx?.maxFeePerGas)} / {quantity(tx?.maxPriorityFeePerGas)} wei</dd></div>
        <div><dt>Gas used</dt><dd>{quantity(receipt?.gasUsed)}</dd></div>
        <div><dt>Effective gas price</dt><dd>{quantity(receipt?.effectiveGasPrice)} wei</dd></div>
        <div><dt>Fee paid</dt><dd>{receipt?.gasUsed && receipt.effectiveGasPrice ? amount(String(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice))) : "—"}</dd></div>
      </dl>
      <h3>Frames · {Math.max(frames.length, frameResults.length)}</h3>
      {!frames.length && <p className="defi-small">No frame envelope is available from this gateway.</p>}
      <div className="transaction-frames">{Array.from({ length: Math.max(frames.length, frameResults.length) }, (_, index) => {
        const frame = frames[index], result = frameResults[index];
        const mode = ["DEFAULT", "VERIFY", "SENDER"][numeric(frame?.mode)] ?? "Unknown";
        const flags = numeric(frame?.flags);
        const approvals = mode === "VERIFY" ? [flags & 2 ? "execution" : "", flags & 1 ? "payment" : ""].filter(Boolean).join(" + ") || "none" : "none";
        return <details key={index} open className="transaction-frame"><summary>Frame {index} · {mode} · {result ? result.status === "0x1" ? "Succeeded" : "Reverted" : "Unconfirmed"}</summary>
          <dl className="transaction-facts"><div><dt>Target</dt><dd>{frame?.to ?? frame?.target ?? tx?.sender ?? tx?.from ?? "Sender"}</dd></div><div><dt>Approves</dt><dd>{approvals}</dd></div><div><dt>Execution gas limit / used</dt><dd>{quantity(frame?.gasLimit ?? frame?.limits?.execution)} / {quantity(result?.gasUsed)}</dd></div><div><dt>State gas limit / used</dt><dd>{quantity(frame?.stateLimit ?? frame?.limits?.state)} / {quantity(result?.stateGasUsed)}</dd></div><div><dt>Value</dt><dd>{amount(frame?.value)}</dd></div><div><dt>Event logs</dt><dd>{result?.logs?.length ?? "—"}</dd></div></dl>
          <Raw title={`Calldata · ${frame?.data ? (frame.data.length - 2) / 2 : 0} bytes`} value={frame?.data ?? "0x"} />
        </details>;
      })}</div>
      <h3>Admission</h3>
      {snapshot.warnings.map(warning => <p className="defi-small" key={warning}>{warning}</p>)}
      {snapshot.admission?.admission && <><p>{snapshot.admission.admission.outcome}</p>{snapshot.admission.admission.checks?.map((check, i) => <p className="defi-small" key={i}>{check.rule}{check.frameIndex !== undefined ? ` · frame ${check.frameIndex}` : ""}: {check.verdict}{check.detail ? ` — ${check.detail}` : ""}</p>)}</>}
      <Raw title={`Receipt and events · ${receipt?.logs?.length ?? 0} logs`} value={receipt} />
      <Raw title="Transaction envelope" value={tx} />
      <Raw title="Admission and timeline" value={snapshot.admission} />
    </>}
  </dialog>;
}
