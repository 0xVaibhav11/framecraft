"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, http, keccak256, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { frame, getProfile, privateKeyToFrameSigner, txHash, type FrameTx } from "@framepay/sdk";
import deployments from "../../../../../config/defi.json";
import paymasters from "../../../../../config/paymasters.json";
import { useNetwork } from "../network";
import { frameClient, rpc } from "@/lib/rpc";
import { tokenAbi, type AppDeployment, type Position } from "@/lib/defi-contracts";

export type AppCall = { to: Address; data: Hex; value?: bigint };
export type Activity = { hash: Hex; title: string; status: "pending" | "confirmed" | "failed"; frameCount: number; at: number };
export type Review = { title: string; details: [string, string][]; assertions: string[]; transaction: FrameTx; deadline?: number; position?: Position };
const errorMessage = (error: unknown) => error instanceof Error ? error.message.split("\n")[0] : "The request failed. Try inspecting the transaction.";
const safeStore = (store: Storage, key: string, value: unknown) => store.setItem(key, JSON.stringify(value));

export function useDefi() {
  const network = useNetwork();
  const deployment = deployments[network.id] as AppDeployment | null;
  const sponsor = paymasters[network.id];
  const storageKey = `framepay:defi:${network.id}:${deployment?.genesisHash ?? "unavailable"}`;
  const [key, setKey] = useState<Hex | null>(null);
  const account = useMemo(() => key ? privateKeyToAccount(key) : null, [key]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [pending, setPending] = useState<Activity | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [balances, setBalances] = useState({ usd: 0n, asset: 0n, eth: 0n });
  const [claimed, setClaimed] = useState({ usd: false, asset: false });
  const [refreshVersion, setRefreshVersion] = useState(0);
  const mounted = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const publicClient = useMemo(() => createPublicClient({ transport: http(`/api/rpc?network=${network.id}`, { retryCount: 0, timeout: 12_000 }) }), [network.id]);

  useEffect(() => {
    mounted.current = true;
    try {
      const savedKey = sessionStorage.getItem(`${storageKey}:key`);
      if (savedKey) { privateKeyToAccount(savedKey as Hex); setKey(savedKey as Hex); }
      const saved = JSON.parse(localStorage.getItem(`${storageKey}:activity`) ?? "[]") as Activity[];
      if (Array.isArray(saved)) {
        const valid = saved.filter(item => /^0x[0-9a-fA-F]{64}$/.test(item.hash) && ["pending", "confirmed", "failed"].includes(item.status) && Number.isInteger(item.frameCount));
        setActivity(valid);
        setPending(valid.find(item => item.status === "pending") ?? null);
      }
      const savedPositions = JSON.parse(localStorage.getItem(`${storageKey}:positions`) ?? "[]");
      if (Array.isArray(savedPositions)) setPositions(savedPositions.filter(item => item?.orderHash && item?.policy && item?.order));
    } catch { setNotice("Saved tab data could not be restored. Create a test account to continue."); }
    return () => { mounted.current = false; abort.current?.abort(); };
  }, [storageKey]);

  const refresh = useCallback(async () => {
    if (!deployment || !sponsor) { setReady(false); return; }
    try {
      const genesis = await rpc<{ hash: Hex }>("eth_getBlockByNumber", ["0x0", false], network.id);
      if (genesis.hash !== deployment.genesisHash || genesis.hash !== sponsor.genesisHash) throw new Error("This deployment belongs to a different devnet. Update the app deployment after the chain reset.");
      const contracts = [...Object.entries(deployment.contracts), ["paymaster", sponsor.address]];
      await Promise.all(contracts.map(async ([name, address]) => {
        const code = await rpc<Hex>("eth_getCode", [address, "latest"], network.id);
        if (code === "0x" || keccak256(code) !== (name === "paymaster" ? sponsor.codeHash : deployment.codeHashes[name]))
          throw new Error(`The recorded ${name} contract does not match this devnet.`);
      }));
      if (!mounted.current) return;
      setReady(true);
      if (account) {
        const [usd, asset, eth, usdClaimed, assetClaimed] = await Promise.all([
          publicClient.readContract({ address: deployment.contracts.usd, abi: tokenAbi, functionName: "balanceOf", args: [account.address] }),
          publicClient.readContract({ address: deployment.contracts.asset, abi: tokenAbi, functionName: "balanceOf", args: [account.address] }),
          rpc<Hex>("eth_getBalance", [account.address, "latest"], network.id),
          publicClient.readContract({ address: deployment.contracts.usd, abi: tokenAbi, functionName: "claimed", args: [account.address] }),
          publicClient.readContract({ address: deployment.contracts.asset, abi: tokenAbi, functionName: "claimed", args: [account.address] }),
        ]);
        if (!mounted.current) return;
        setBalances({ usd, asset, eth: BigInt(eth) }); setClaimed({ usd: usdClaimed, asset: assetClaimed });
      }
      setRefreshVersion(value => value + 1);
    } catch (err) { if (mounted.current) { setReady(false); setError(errorMessage(err)); } }
  }, [account, deployment, sponsor, network.id, publicClient]);
  useEffect(() => { void refresh(); }, [refresh]);
  const locked = busy || review !== null || pending !== null;
  useEffect(() => { network.setLocked(locked); return () => network.setLocked(false); }, [locked, network.setLocked]);
  useEffect(() => {
    if (!locked) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [locked]);

  function createAccount() {
    if (locked) return;
    const value = generatePrivateKey();
    // Test-only account survives refreshes in this tab. Keys are never sent to the app server.
    try { sessionStorage.setItem(`${storageKey}:key`, value); }
    catch { setError("Browser storage is unavailable. Enable session storage before creating a test account."); return; }
    setKey(value); setError(""); setNotice("Test account created. Export it before closing this tab if you want to keep it.");
  }
  function exportAccount() {
    if (!key || !account) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ network: network.id, genesisHash: deployment?.genesisHash, address: account.address, privateKey: key }, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `framepay-test-account-${account.address.slice(2, 8)}.json`; anchor.click(); URL.revokeObjectURL(url);
    setNotice("Test account exported. This file contains its private key; keep it private.");
  }
  function importAccount(raw: string) {
    if (locked || !deployment) return;
    try {
      const saved = JSON.parse(raw);
      if (saved.network !== network.id || saved.genesisHash !== deployment.genesisHash) throw new Error("This account export belongs to another network or genesis.");
      const imported = privateKeyToAccount(saved.privateKey);
      if (imported.address.toLowerCase() !== String(saved.address).toLowerCase()) throw new Error("The exported address does not match its key.");
      sessionStorage.setItem(`${storageKey}:key`, saved.privateKey);
      setKey(saved.privateKey); setError(""); setNotice("Test account restored in this tab.");
    } catch { setError("Could not import this test account. Check that the file belongs to this local deployment."); }
  }
  async function task(fn: () => Promise<void>) {
    if (busyRef.current || review || pending) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (err) { if (mounted.current) setError(errorMessage(err)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  function remember(entry: Activity) {
    setActivity(current => {
      const next = [entry, ...current.filter(item => item.hash !== entry.hash)].slice(0, 30);
      try { safeStore(localStorage, `${storageKey}:activity`, next); } catch { /* Hash remains visible in memory. */ }
      return next;
    });
  }
  function savePosition(position: Position) {
    setPositions(current => {
      const next = [position, ...current.filter(item => item.orderHash !== position.orderHash)];
      try { safeStore(localStorage, `${storageKey}:positions`, next); } catch { setNotice("Position is visible in this session, but browser persistence is unavailable."); }
      return next;
    });
  }
  async function prepare(args: { title: string; details: [string, string][]; assertions: string[]; calls: AppCall[]; sponsored: boolean; deadline?: number; position?: Position }) {
    if (!account || !ready || !deployment || !sponsor) throw new Error("Create an account and connect to the deployed local contracts first.");
    const profile = getProfile("ethrex-eip8141-tracer");
    const frames = [frame(profile, "VERIFY", { scope: args.sponsored ? "EXECUTION" : "EXECUTION_AND_PAYMENT", execution: 30_000n })];
    if (args.sponsored) frames.push(frame(profile, "VERIFY", { target: sponsor.address as Address, scope: "PAYMENT", execution: 50_000n }));
    for (const call of args.calls) frames.push(frame(profile, "SENDER", { target: call.to, data: call.data, value: call.value ?? 0n, execution: 600_000n, state: 1_500_000n }));
    const value = args.calls.reduce((sum, call) => sum + (call.value ?? 0n), 0n);
    const liveBalance = BigInt(await rpc<Hex>("eth_getBalance", [account.address, "latest"], network.id));
    if (liveBalance < value || (!args.sponsored && liveBalance < value + 50_000_000_000_000n)) throw new Error("Your account needs the transfer value and, when paying your own gas, test ETH for fees.");
    const transaction = await frameClient(network.id).prepareFrameTransaction({ sender: account.address, frames, maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 1_000_000n });
    setReview({ ...args, transaction, details: [...args.details, ["Gas payer", args.sponsored ? "FramePay paymaster" : "Your test account"]] });
  }
  async function inspect(entry = pending) {
    if (!entry || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const receipt = await frameClient(network.id).getFrameReceipt({ hash: entry.hash });
      if (!receipt) { setNotice("No receipt yet. This transaction may still execute; inspect again before sending another."); return; }
      const ok = receipt.status === "0x1" && receipt.frameReceipts.length === entry.frameCount && receipt.frameReceipts.every(item => item.status === "0x1");
      remember({ ...entry, status: ok ? "confirmed" : "failed" }); setPending(null);
      setNotice(ok ? "Transaction confirmed. All frames succeeded." : "At least one frame failed. Inspect the receipt; an earlier approval may have succeeded.");
      await refresh();
    } catch (err) { setError(errorMessage(err)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function confirm() {
    if (!review || !key || busyRef.current) return;
    const intent = review;
    if (intent.deadline && intent.deadline <= Date.now() / 1000) { setReview(null); setError("This review expired. Prepare a fresh transaction."); return; }
    busyRef.current = true; setBusy(true); setError("");
    let entry: Activity | undefined;
    try {
      const client = frameClient(network.id);
      const signed = await client.signFrameTransaction({ transaction: intent.transaction, signer: privateKeyToFrameSigner(key) });
      entry = { hash: txHash(getProfile("ethrex-eip8141-tracer"), signed), title: intent.title, status: "pending", frameCount: signed.frames.length, at: Date.now() };
      // Durable public hash before a single submission attempt; the signing key stays in this tab.
      safeStore(localStorage, `${storageKey}:activity`, [entry, ...activity.filter(item => item.hash !== entry!.hash)].slice(0, 30));
      if (intent.position) savePosition(intent.position);
      remember(entry); setPending(entry); setReview(null);
      await client.sendFrameTransaction({ transaction: signed });
      setNotice("Submitted. Waiting for all frames to execute…");
      abort.current = new AbortController();
      await client.waitForFrameReceipt({ hash: entry.hash, expectedFrameCount: entry.frameCount, signal: abort.current.signal });
      if (!mounted.current) return;
      remember({ ...entry, status: "confirmed" }); setPending(null); setNotice(`${intent.title} confirmed. All frames succeeded.`);
      await refresh();
    } catch (err) {
      if (mounted.current) { setError(errorMessage(err)); if (entry) setNotice("Inspect the saved transaction before trying another submission."); }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  return { network, deployment, sponsor, account, ready, busy, locked, error, setError, notice, setNotice,
    review, setReview, pending, activity, positions, savePosition, balances, claimed, publicClient,
    refreshVersion, storageKey, refresh, createAccount, exportAccount, importAccount, task, prepare, confirm, inspect };
}
