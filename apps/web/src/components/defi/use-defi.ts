"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, encodeFunctionData, http, isAddress, keccak256, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { frame, getProfile, privateKeyToFrameSigner, txHash, type FrameTx, registerPasskey, signWithPasskey, passkeyChallenge, passkeyFactoryArgs, passkeyFactoryAbi, passkeyWalletAbi, type PasskeyCredential, type WalletCall } from "@framepay/sdk";
import deployments from "../../../../../config/defi.json";
import passkeyDeployments from "../../../../../config/passkeys.json";
import paymasters from "../../../../../config/paymasters.json";
import { useNetwork } from "../network";
import { frameClient, rpc } from "@/lib/rpc";
import { tokenAbi, type AppDeployment, type Position } from "@/lib/defi-contracts";

export type AppCall = { to: Address; data: Hex; value?: bigint };
export type Activity = { hash: Hex; title: string; status: "pending" | "confirmed" | "failed"; frameCount: number; at: number };
type PasskeyWallet = PasskeyCredential & { address: Address; networkDomain: Hex; factory: Address };
function parseWallet(value: unknown): PasskeyWallet {
  if (!value || typeof value !== "object") throw new Error("Invalid wallet metadata.");
  const w = value as PasskeyWallet;
  if (!isAddress(w.address) || !isAddress(w.factory) || ![w.qx, w.qy, w.networkDomain].every(item => typeof item === "string" && /^0x[0-9a-fA-F]{64}$/.test(item))
    || typeof w.credentialId !== "string" || w.credentialId.length > 1400 || typeof w.origin !== "string" || typeof w.rpId !== "string") throw new Error("Invalid wallet metadata.");
  const url = new URL(w.origin);
  if (url.origin !== w.origin || url.hostname !== w.rpId || w.origin.length > 255) throw new Error("Invalid passkey site.");
  passkeyFactoryArgs(w, w.networkDomain);
  return { address: w.address, factory: w.factory, qx: w.qx, qy: w.qy, networkDomain: w.networkDomain, credentialId: w.credentialId, origin: w.origin, rpId: w.rpId };
}
export type Review = { title: string; details: [string, string][]; assertions: string[]; transaction?: FrameTx; walletBatch?: { calls: WalletCall[]; nonce: bigint; challenge: Hex }; deadline?: number; position?: Position };
const errorMessage = (error: unknown) => error instanceof Error ? error.message.split("\n")[0] : "The request failed. Try inspecting the transaction.";
const safeStore = (store: Storage, key: string, value: unknown) => store.setItem(key, JSON.stringify(value));

export function useDefi() {
  const network = useNetwork();
  const deployment = deployments[network.id] as AppDeployment | null;
  const sponsor = paymasters[network.id];
  const passkeyDeployment = passkeyDeployments[network.id];
  const storageKey = `framepay:defi:${network.id}:${deployment?.genesisHash ?? "unavailable"}`;
  const [key, setKey] = useState<Hex | null>(null);
  const [wallet, setWallet] = useState<PasskeyWallet | null>(null);
  const [walletDeployed, setWalletDeployed] = useState(false);
  const relayAccount = useMemo(() => key ? privateKeyToAccount(key) : null, [key]);
  const account = useMemo(() => wallet ? { address: wallet.address } : relayAccount, [wallet, relayAccount]);
  const accountAddress = account?.address;
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
  const refreshGeneration = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const publicClient = useMemo(() => createPublicClient({ transport: http(`/api/rpc?network=${network.id}`, { retryCount: 0, timeout: 12_000 }) }), [network.id]);

  useEffect(() => {
    mounted.current = true;
    try {
      const savedWallet = localStorage.getItem(`${storageKey}:passkey`);
      if (savedWallet) setWallet(parseWallet(JSON.parse(savedWallet)));
      let savedKey = sessionStorage.getItem(`${storageKey}:key`);
      if (savedWallet && !savedKey) { savedKey = generatePrivateKey(); sessionStorage.setItem(`${storageKey}:key`, savedKey); }
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
    return () => { mounted.current = false; refreshGeneration.current++; abort.current?.abort(); };
  }, [storageKey]);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
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
      if (passkeyDeployment) {
        if (passkeyDeployment.genesisHash !== genesis.hash || keccak256(await rpc<Hex>("eth_getCode", [passkeyDeployment.factory, "latest"], network.id)) !== passkeyDeployment.factoryCodeHash) throw new Error("Passkey factory does not match this devnet.");
      }
      if (wallet) {
        if (!passkeyDeployment || wallet.networkDomain !== genesis.hash || wallet.factory.toLowerCase() !== passkeyDeployment.factory.toLowerCase()) throw new Error("This passkey wallet belongs to another deployment.");
        const predicted = await publicClient.readContract({ address: wallet.factory, abi: passkeyFactoryAbi, functionName: "predict", args: passkeyFactoryArgs(wallet, wallet.networkDomain) });
        if (predicted.toLowerCase() !== wallet.address.toLowerCase()) throw new Error("Passkey wallet address does not match its public key and factory.");
        const code = await rpc<Hex>("eth_getCode", [wallet.address, "latest"], network.id);
        if (code !== "0x") {
          const names = ["qx", "qy", "rpIdHash", "originHash", "networkDomain"] as const;
          const values = await Promise.all(names.map(functionName => publicClient.readContract({ address: wallet.address, abi: passkeyWalletAbi, functionName })));
          const expected = passkeyFactoryArgs(wallet, wallet.networkDomain);
          if (values.some((value, index) => value.toLowerCase() !== expected[index].toLowerCase())) throw new Error("Deployed wallet owner or domain mismatch.");
        }
        if (mounted.current && generation === refreshGeneration.current) setWalletDeployed(code !== "0x");
      }
      if (!mounted.current || generation !== refreshGeneration.current) return;
      setReady(true);
      if (accountAddress) {
        const [usd, asset, eth, usdClaimed, assetClaimed] = await Promise.all([
          publicClient.readContract({ address: deployment.contracts.usd, abi: tokenAbi, functionName: "balanceOf", args: [accountAddress] }),
          publicClient.readContract({ address: deployment.contracts.asset, abi: tokenAbi, functionName: "balanceOf", args: [accountAddress] }),
          rpc<Hex>("eth_getBalance", [accountAddress, "latest"], network.id),
          publicClient.readContract({ address: deployment.contracts.usd, abi: tokenAbi, functionName: "claimed", args: [accountAddress] }),
          publicClient.readContract({ address: deployment.contracts.asset, abi: tokenAbi, functionName: "claimed", args: [accountAddress] }),
        ]);
        if (!mounted.current || generation !== refreshGeneration.current) return;
        setBalances({ usd, asset, eth: BigInt(eth) }); setClaimed({ usd: usdClaimed, asset: assetClaimed });
      }
      setRefreshVersion(value => value + 1);
    } catch (err) { if (mounted.current && generation === refreshGeneration.current) { setReady(false); setError(errorMessage(err)); } }
  }, [accountAddress, wallet, deployment, passkeyDeployment, sponsor, network.id, publicClient]);
  useEffect(() => { void refresh(); return () => { refreshGeneration.current++; }; }, [refresh]);
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
    localStorage.removeItem(`${storageKey}:passkey`); setWallet(null); setWalletDeployed(false);
    setKey(value); setError(""); setNotice("Test account created. Export it before closing this tab if you want to keep it.");
  }
  function ensureRelayKey() {
    if (key) return key;
    const value = generatePrivateKey(); sessionStorage.setItem(`${storageKey}:key`, value); setKey(value); return value;
  }
  async function createPasskey() {
    if (!ready || !deployment || !passkeyDeployment) throw new Error("Connect to the deployed local passkey factory first.");
    // Start the native credential prompt directly from the user's click.
    const credential = await registerPasskey();
    const address = await publicClient.readContract({ address: passkeyDeployment.factory as Address, abi: passkeyFactoryAbi, functionName: "predict", args: passkeyFactoryArgs(credential, deployment.genesisHash) });
    const record: PasskeyWallet = { ...credential, address, networkDomain: deployment.genesisHash, factory: passkeyDeployment.factory as Address };
    ensureRelayKey();
    safeStore(localStorage, `${storageKey}:passkey`, record); setWallet(record); setWalletDeployed(false);
    setNotice("Passkey created. Deploy your wallet next; the paymaster covers the local network fee.");
  }
  async function relayTransaction(calls: AppCall[], sponsored: boolean, deploying = false) {
    const relayKey = ensureRelayKey();
    const sender = privateKeyToAccount(relayKey).address;
    const profile = getProfile("ethrex-eip8141-tracer");
    const frames = [frame(profile, "VERIFY", { scope: sponsored ? "EXECUTION" : "EXECUTION_AND_PAYMENT", execution: 30_000n })];
    if (sponsored) frames.push(frame(profile, "VERIFY", { target: sponsor!.address as Address, scope: "PAYMENT", execution: 50_000n }));
    for (const call of calls) frames.push(frame(profile, "SENDER", { target: call.to, data: call.data, value: call.value ?? 0n,
      execution: deploying ? 2_000_000n : wallet ? 1_500_000n : 600_000n, state: deploying ? 14_000_000n : wallet ? 6_000_000n : 1_500_000n }));
    return frameClient(network.id).prepareFrameTransaction({ sender, frames, maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 1_000_000n });
  }
  async function deployWallet() {
    if (!wallet || !ready || walletDeployed) throw new Error("Create a passkey before deploying its wallet.");
    const data = encodeFunctionData({ abi: passkeyFactoryAbi, functionName: "createWallet", args: passkeyFactoryArgs(wallet, wallet.networkDomain) });
    const transaction = await relayTransaction([{ to: wallet.factory, data }], true, true);
    setReview({ title: "Deploy passkey wallet", details: [["Wallet", wallet.address], ["Passkey site", wallet.origin], ["Gas payer", "FramePay paymaster"]], assertions: ["Only your passkey can authorize wallet spending", "No recovery key or upgrade administrator", "Wallet creation does not move your existing account’s assets"], transaction });
  }
  function exportAccount() {
    if (!account || (!wallet && !key)) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(wallet ? { type: "framepay-passkey-v1", network: network.id, genesisHash: deployment?.genesisHash, wallet } : { network: network.id, genesisHash: deployment?.genesisHash, address: account.address, privateKey: key }, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `framepay-${wallet ? "wallet-metadata" : "test-account"}-${account.address.slice(2, 8)}.json`; anchor.click(); URL.revokeObjectURL(url);
    setNotice(wallet ? "Wallet metadata exported. It contains no private key; you still need the original or synced passkey to authorize transactions." : "Test account exported. This file contains its private key; keep it private.");
  }
  function importAccount(raw: string) {
    if (locked || !deployment) return;
    try {
      const saved = JSON.parse(raw);
      if (saved.network !== network.id || saved.genesisHash !== deployment.genesisHash) throw new Error("This account export belongs to another network or genesis.");
      if (saved.type === "framepay-passkey-v1") {
        saved.wallet = parseWallet(saved.wallet);
        if (!passkeyDeployment || saved.wallet?.factory?.toLowerCase() !== passkeyDeployment.factory.toLowerCase() || saved.wallet?.networkDomain !== deployment.genesisHash) throw new Error("Wallet deployment mismatch.");
        passkeyFactoryArgs(saved.wallet, deployment.genesisHash);
        ensureRelayKey(); safeStore(localStorage, `${storageKey}:passkey`, saved.wallet); setReady(false); setWallet(saved.wallet); setWalletDeployed(false); setError("");
        setNotice("Public wallet metadata restored. Your passkey is still required to spend."); return;
      }
      const imported = privateKeyToAccount(saved.privateKey);
      if (imported.address.toLowerCase() !== String(saved.address).toLowerCase()) throw new Error("The exported address does not match its key.");
      sessionStorage.setItem(`${storageKey}:key`, saved.privateKey);
      localStorage.removeItem(`${storageKey}:passkey`); setWallet(null); setWalletDeployed(false);
      setKey(saved.privateKey); setError(""); setNotice("Test account restored in this tab.");
    } catch { setError("Could not import this wallet or test account. Check that the export belongs to this local deployment."); }
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
    const value = args.calls.reduce((sum, call) => sum + (call.value ?? 0n), 0n);
    const liveBalance = BigInt(await rpc<Hex>("eth_getBalance", [account.address, "latest"], network.id));
    if (liveBalance < value || (!args.sponsored && liveBalance < value + 50_000_000_000_000n)) throw new Error("Your account needs the transfer value and, when paying your own gas, test ETH for fees.");
    if (wallet) {
      if (!walletDeployed) throw new Error("Deploy your passkey wallet first.");
      if (!args.sponsored) throw new Error("Passkey wallets currently use paymaster-sponsored relay transactions.");
      const nonce = await publicClient.readContract({ address: wallet.address, abi: passkeyWalletAbi, functionName: "nonce" });
      const block = await rpc<{ timestamp: Hex }>("eth_getBlockByNumber", ["latest", false], network.id);
      const deadline = args.deadline ?? Number(BigInt(block.timestamp)) + 600;
      const calls = args.calls.map(call => ({ target: call.to, value: call.value ?? 0n, data: call.data }));
      const challenge = passkeyChallenge({ chainId: 1337n, wallet: wallet.address, networkDomain: wallet.networkDomain, nonce, deadline: BigInt(deadline), calls });
      const expected = await publicClient.readContract({ address: wallet.address, abi: passkeyWalletAbi, functionName: "challenge", args: [calls, nonce, BigInt(deadline)] });
      if (challenge !== expected) throw new Error("Local and onchain authorization challenges differ.");
      setReview({ ...args, deadline, walletBatch: { calls, nonce, challenge }, assertions: [...args.assertions, "Passkey signature and replay nonce verified on-chain", "The complete wallet batch succeeds or reverts together"], details: [...args.details, ["Wallet", wallet.address], ["Authorization", "Passkey · user verification required"], ["Gas payer", "FramePay paymaster"]] });
    } else {
      const transaction = await relayTransaction(args.calls, args.sponsored);
      setReview({ ...args, transaction, details: [...args.details, ["Gas payer", args.sponsored ? "FramePay paymaster" : "Your test account"]] });
    }
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
      let transaction = intent.transaction;
      if (intent.walletBatch) {
        if (!wallet || !intent.deadline) throw new Error("Passkey review is incomplete.");
        const proof = await signWithPasskey(wallet, intent.walletBatch.challenge);
        const batch = intent.walletBatch;
        const valid = await publicClient.readContract({ address: wallet.address, abi: passkeyWalletAbi, functionName: "verify", args: [batch.calls, batch.nonce, BigInt(intent.deadline), proof] });
        if (!valid) throw new Error("Onchain passkey verification failed or this approval expired. Prepare a new review.");
        const data = encodeFunctionData({ abi: passkeyWalletAbi, functionName: "execute", args: [batch.calls, batch.nonce, BigInt(intent.deadline), proof] });
        transaction = await relayTransaction([{ to: wallet.address, data }], true);
      }
      if (!transaction) throw new Error("Missing prepared transaction.");
      const signed = await client.signFrameTransaction({ transaction, signer: privateKeyToFrameSigner(key) });
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
      if (mounted.current) { setError(errorMessage(err)); if (entry) setNotice("Inspect the saved transaction before trying another submission."); else setReview(null); }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  return { network, deployment, sponsor, account, ready, busy, locked, error, setError, notice, setNotice,
    review, setReview, pending, activity, positions, savePosition, balances, claimed, publicClient, wallet, walletDeployed, createPasskey, deployWallet,
    refreshVersion, storageKey, refresh, createAccount, exportAccount, importAccount, task, prepare, confirm, inspect };
}
