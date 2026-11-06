import "@evmcrispr/editor/style.css";
import "../styles/editor.css";
import { createEvml, type EvmlScript, type ModuleInput } from "@evmcrispr/core";
import { EvmcrisprTerminal } from "@evmcrispr/editor";
import Frame from "@evmcrispr/module-frame";
import { frameNetworks, privateKeyToFrameSigner, type FrameNetworkId, type FrameSigner } from "@framepay/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatEther, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import deployments from "../../../../config/defi.json";
import paymasters from "../../../../config/paymasters.json";
import { makeFrameHandler, refuseOtherActions, type SentFrameTransaction } from "../lib/evml-frames";
import { rpc, shortHex, transportOf } from "../lib/frame-rpc";

// EVML with the `frame` module registered directly, so `load frame` works
// without EVMcrispr's experimental flag. `std` (exec, batch, set, …) is built in.
const evml = createEvml().use(Frame as unknown as ModuleInput);
const NETWORKS = Object.keys(frameNetworks) as FrameNetworkId[];
type Status = "checking" | "online" | "offline" | "wrong-chain";

/** A script that runs as written on the selected network. */
function starterScript(networkId: FrameNetworkId) {
  const tokens = (deployments as Record<string, { contracts: { usd: string; asset: string } } | null>)[networkId];
  const sponsor = (paymasters as Record<string, { address: string } | null>)[networkId];
  const header = sponsor
    ? `# One EIP-8141 frame transaction, gas paid by the FramePay paymaster.
# frame:tx adds the verify frames: yours (execution), then the paymaster's (payment).`
    : `# One EIP-8141 frame transaction, paid by your test account (use the faucet first).
# frame:tx adds the self-verify frame (execution and payment).`;
  const vars = [
    tokens && `set $usd ${tokens.contracts.usd}\nset $asset ${tokens.contracts.asset}`,
    sponsor && `set $paymaster ${sponsor.address}`,
  ].filter(Boolean).join("\n");
  const body = tokens
    ? `  # Atomic: both claims land, or neither does.
  batch (
    exec $usd "claim()"
    exec $asset "claim()"
  )`
    : `  send 0x000000000000000000000000000000000000dEaD --value 0`;
  return `${header}
load frame [tx]
${vars ? `\n${vars}\n` : ""}
tx ${sponsor ? "--paymaster $paymaster " : ""}(
${body}
)
`;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message.slice(0, 400) : "The request failed.");

export default function EvmlEditor() {
  const [networkId, setNetworkId] = useState<FrameNetworkId>("devnet");
  const environment = frameNetworks[networkId];
  const [status, setStatus] = useState<Status>("checking");
  const [block, setBlock] = useState<bigint | null>(null);
  const signer = useRef<FrameSigner | null>(null);
  const [address, setAddress] = useState<Hex | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [funding, setFunding] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<SentFrameTransaction[]>([]);
  // The script survives a network switch unless it is still the starter.
  const scriptRef = useRef(starterScript(networkId));
  const [editorKey, setEditorKey] = useState(0);
  const connected = status === "online";

  const checkNetwork = useCallback(async () => {
    setStatus("checking");
    try {
      const [chainId, height, genesis] = await Promise.all([
        rpc<Hex>(networkId, "eth_chainId"),
        rpc<Hex>(networkId, "eth_blockNumber"),
        "genesisHash" in environment ? rpc<{ hash: Hex }>(networkId, "eth_getBlockByNumber", ["0x0", false]) : null,
      ]);
      if (BigInt(chainId) !== BigInt(environment.chainId) || ("genesisHash" in environment && genesis?.hash !== environment.genesisHash)) {
        setStatus("wrong-chain");
        setBlock(null);
        return;
      }
      setBlock(BigInt(height));
      setStatus("online");
    } catch {
      setStatus("offline");
      setBlock(null);
    }
  }, [environment, networkId]);
  useEffect(() => { void checkNetwork(); }, [checkNetwork]);

  const refreshBalance = useCallback(async (target = signer.current?.address) => {
    if (!target) return;
    try { setBalance(BigInt(await rpc<Hex>(networkId, "eth_getBalance", [target, "latest"]))); }
    catch { setBalance(null); }
  }, [networkId]);

  // A fresh disposable account per page load and per network.
  const createAccount = useCallback(() => {
    signer.current = privateKeyToFrameSigner(generatePrivateKey());
    setAddress(signer.current.address);
    setBalance(null);
    setSent([]);
    setError("");
    void refreshBalance(signer.current.address);
  }, [refreshBalance]);
  useEffect(() => { createAccount(); }, [createAccount]);

  function selectNetwork(next: FrameNetworkId) {
    if (scriptRef.current === starterScript(networkId)) scriptRef.current = starterScript(next);
    setNetworkId(next);
    setEditorKey((key) => key + 1);
  }

  async function fund() {
    if (!address) return;
    setFunding(true);
    setError("");
    try {
      const funded = await rpc<{ txHash: Hex }>(networkId, "skandha_explorer_faucet", [address]);
      if (!/^0x[\da-fA-F]{64}$/.test(funded.txHash)) throw new Error("The faucet returned an invalid transaction hash.");
      const end = Date.now() + 120_000;
      while (Date.now() < end) {
        const receipt = await rpc<{ status: string } | null>(networkId, "eth_getTransactionReceipt", [funded.txHash]);
        if (receipt) {
          if (receipt.status !== "0x1") throw new Error("The faucet transfer reverted.");
          await refreshBalance();
          return;
        }
        await new Promise((done) => setTimeout(done, 2_000));
      }
      throw new Error("Faucet receipt timed out. Check the funding hash before requesting again.");
    } catch (err) { setError(errorText(err)); }
    finally { setFunding(false); }
  }

  const transports = useMemo(() => ({ [environment.chainId]: transportOf(networkId) }), [environment.chainId, networkId]);
  const record = useCallback((update: SentFrameTransaction) => {
    setSent((list) => [update, ...list.filter((item) => item.hash !== update.hash)]);
  }, []);

  const executeAction = useCallback(async (script: EvmlScript) => {
    const current = signer.current;
    if (!current) throw new Error("Create a test account first.");
    setRunning(true);
    setError("");
    try {
      await script.execute(undefined, {
        prepareChains: false,
        handlers: { ...refuseOtherActions(), frame: makeFrameHandler({ networkId, signer: current, onUpdate: record }) },
      });
    } finally {
      setRunning(false);
      void refreshBalance(current.address);
    }
  }, [networkId, record, refreshBalance]);

  return (
    <div className="evml">
      <div className="evml-toolbar">
        <label>
          Network
          <select value={networkId} disabled={running} onChange={(event) => selectNetwork(event.target.value as FrameNetworkId)}>
            {NETWORKS.map((id) => <option key={id} value={id}>{frameNetworks[id].name}</option>)}
          </select>
        </label>
        <span className={`evml-dot ${connected ? "online" : ""}`} />
        <span className="evml-muted">
          {status === "checking" ? "Checking gateway…" : connected ? `Block ${block}` : status === "wrong-chain" ? "Different chain" : "Gateway not connected"}
        </span>
        <button className="evml-link" onClick={() => void checkNetwork()}>Recheck</button>
      </div>
      {(status === "offline" || status === "wrong-chain") && (
        <p className="evml-banner">
          {status === "wrong-chain"
            ? `The gateway at ${environment.rpcUrl} is on a different chain or genesis than the ${environment.name}.`
            : `The ${environment.name} is unreachable at ${environment.rpcUrl}. You can still write and check scripts.`}
        </p>
      )}
      <div className="evml-grid">
        <section className="evml-terminal">
          {/* The terminal provides its own EvmcrisprProvider from these props. */}
          <EvmcrisprTerminal
            key={`${networkId}:${editorKey}`}
            evml={evml}
            transports={transports}
            chainId={environment.chainId}
            account={address ?? undefined}
            defaultScript={scriptRef.current}
            onScriptChange={(value: string) => { scriptRef.current = value; }}
            height={440}
            fontSize={14}
            executeAction={address ? executeAction : undefined}
          />
          <p className="evml-hint">
            Run interprets the script and sends each <code>frame:tx</code> as one frame transaction. Calls outside a{" "}
            <code>frame:tx</code> block are refused: this page has no wallet for plain transactions. Body frames
            without <code>--gas</code> or <code>--state-gas</code> get the DeFi app’s EOA budget (600,000 / 1,500,000).
          </p>
        </section>
        <aside className="evml-side">
          <section className="evml-card">
            <h2>Test account <span className="evml-badge">SECP256K1</span></h2>
            {address && (
              <div className="evml-account">
                <div>
                  <small>SENDER · @me</small>
                  <strong title={address}>{shortHex(address)}</strong>
                  <button className="evml-link" onClick={() => void navigator.clipboard.writeText(address).catch(() => setError("Clipboard access is unavailable."))}>Copy</button>
                </div>
                <div>
                  <small>BALANCE</small>
                  <strong>{balance === null ? "—" : `${Number(formatEther(balance)).toFixed(6)} ETH`}</strong>
                  <button className="evml-link" onClick={() => void refreshBalance()}>Refresh</button>
                </div>
              </div>
            )}
            <div className="evml-actions">
              <button className="evml-button" disabled={!address || !connected || funding || running} onClick={() => void fund()}>
                {funding ? "Waiting for funding…" : "Get test ETH from faucet"}
              </button>
              <button className="evml-link" disabled={running} onClick={createAccount}>New account</button>
            </div>
            <p className="evml-hint">
              The key stays in this page’s memory: reloading or switching networks replaces the account. Sponsored
              scripts (<code>--paymaster</code>) need no ETH. Use test funds only.
            </p>
            {error && <p className="evml-hint evml-error">{error}</p>}
          </section>
          <section className="evml-card">
            <h2>Sent frame transactions <span className="evml-badge">{sent.length}</span></h2>
            {sent.length === 0 ? (
              <p className="evml-hint">Nothing sent yet from this account.</p>
            ) : (
              <ul className="evml-sent">
                {sent.map((item) => {
                  const state = item.receipt ? (item.receipt.status === "0x1" ? "ok" : "failed") : item.error ? "failed" : "";
                  const label = item.receipt ? (item.receipt.status === "0x1" ? "Included" : "Reverted") : item.error ? "Unknown" : "Pending";
                  return (
                    <li key={item.hash}>
                      <span className={`evml-status ${state}`}>{label}</span>
                      <code title={item.hash}>{shortHex(item.hash)}</code>
                      <small>
                        {item.frameCount} frames
                        {item.receipt && ` · block ${BigInt(item.receipt.blockNumber)} · ${item.receipt.frameReceipts.filter((f) => f.status === "0x1").length}/${item.receipt.frameReceipts.length} ok`}
                        {item.error && ` · ${item.error}`}
                      </small>
                      {environment.explorerUrl && (
                        <a href={`${environment.explorerUrl}/tx/${item.hash}`} target="_blank" rel="noreferrer">Explorer ↗</a>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
