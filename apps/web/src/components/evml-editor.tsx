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
import Privacy from "../lib/privacy/module";
import { PrivateScriptRuntime, type PrivateRuntimeState } from "../lib/privacy/runtime";
import { PrivateScriptWalletPanel } from "./private-script-wallet";
import { hasPrivateFrames } from '../lib/privacy/frame-plan';
import { loadFrameHistory, saveFrameHistory } from '../lib/evml-history';

// EVML with the `frame` module registered directly, so `load frame` works
// without EVMcrispr's experimental flag. `std` (exec, batch, set, …) is built in.
const evml = createEvml().use(Frame as unknown as ModuleInput, Privacy as unknown as ModuleInput);
const PRIVATE_EXAMPLE = `# Create/deploy your private wallet and get FPA + FPB first.
# Each tx block is ONE alt-mempool submission, with one passkey approval.
# Choose any pocket names. These pockets all belong to YOUR passkey.
load frame [tx]
load privacy [@token]
set $paymaster ${paymasters.devnet.address}

tx --paymaster $paymaster (
  batch (
    privacy:shield @token("FPA") "10" --wallet savings
    privacy:shield @token("FPB") "10" --wallet trading
  )
)

# The previous transaction confirms before these proofs are prepared.
tx --paymaster $paymaster (
  privacy:transfer @token("FPA") "1" trading --wallet savings
)
tx --paymaster $paymaster (
  batch (
    privacy:add-inventory @token("FPA") "2" --wallet savings --inventory liquidity
    privacy:shield @token("FPB") "2" --wallet liquidity
  )
)
privacy:scan
privacy:quote "0.1" --inventory liquidity

# Run a separate block using the exact output printed by privacy:quote:
# tx --paymaster $paymaster (
#   privacy:swap "0.1" --expect "OUTPUT" --wallet trading --inventory liquidity
# )
# Other spending commands can also go inside tx:
# privacy:remove-inventory @token("FPA") "0.5" --wallet savings --inventory liquidity
# privacy:unshield @token("FPA") "0.5" @me --wallet savings # public relay address
# Use your friend's full private address, not a local pocket label:
# privacy:transfer @token("FPA") "0.5" "0zkPRIVATE_RECIPIENT" --wallet savings
# privacy:lock
`;
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
  const [history, setHistory] = useState<Partial<Record<FrameNetworkId, SentFrameTransaction[]>>>({});
  const sent = history[networkId] ?? [];
  useEffect(() => {
    setHistory(current => ({ ...current, [networkId]: current[networkId] ?? loadFrameHistory(networkId) }));
  }, [networkId]);
  const [privateState, setPrivateState] = useState<PrivateRuntimeState>({ viewing: false });
  const [privateFeedback, setPrivateFeedback] = useState<{ message: string; error?: boolean }>({ message: '' });
  const [privateAction, setPrivateAction] = useState<string | null>(null);
  const privateRuntime = useRef<PrivateScriptRuntime | null>(null);
  const runController = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
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
  const remember = useCallback((network: FrameNetworkId, update: SentFrameTransaction) => {
    setHistory(current => {
      const list = current[network] ?? loadFrameHistory(network);
      const previous = list.find(item => item.hash === update.hash);
      const entry = { ...previous, ...update, ...(update.receipt ? { error: undefined, outcome: undefined } : {}) };
      const next = [entry, ...list.filter(item => item.hash !== update.hash)].slice(0, 30);
      saveFrameHistory(network, next);
      return { ...current, [network]: next };
    });
  }, []);
  const record = useCallback((update: SentFrameTransaction) => remember(networkId, update), [networkId, remember]);
  // Private submissions and restored pending transactions always belong to devnet.
  const recordPrivate = useCallback((update: SentFrameTransaction) => remember('devnet', update), [remember]);
  useEffect(() => {
    const runtime = new PrivateScriptRuntime(setPrivateState, recordPrivate);
    privateRuntime.current = runtime;
    try { runtime.restore(); } catch (err) { setError(errorText(err)); }
    const lock = () => { runController.current?.abort(); runtime.lock(); };
    window.addEventListener('pagehide', lock);
    return () => { window.removeEventListener('pagehide', lock); lock(); privateRuntime.current = null; };
  }, [recordPrivate]);
  useEffect(() => { privateRuntime.current?.lock(); }, [networkId]);

  async function privateTask(action: 'create' | 'deploy' | 'faucet' | 'inspect') {
    const runtime = privateRuntime.current, current = signer.current;
    const unavailable = !runtime || !current ? 'Wallet tools are still loading. Try again shortly.'
      : runningRef.current ? 'Another operation is running. Wait for it to finish.'
      : networkId !== 'devnet' ? 'Select Framecraft devnet to use this wallet.' : null;
    if (unavailable || !runtime || !current) { setPrivateFeedback({ message: unavailable!, error: true }); return; }
    runningRef.current = true; setRunning(true); setError('');
    setPrivateAction(action);
    setPrivateFeedback({ message: action === 'deploy' ? 'Checking wallet deployment…' : 'Working…' });
    const controller = new AbortController(); runController.current = controller;
    try {
      if (action === 'create') {
        await runtime.createWallet();
        setPrivateFeedback({ message: 'Wallet created. Select Deploy wallet to put it onchain.' });
      } else if (action === 'inspect') {
        await runtime.inspect();
        setPrivateFeedback({ message: 'Transaction inspection complete.' });
      } else {
        await runtime[action](current, controller.signal, message => setPrivateFeedback({ message }));
        if (action === 'faucet') setPrivateFeedback({ message: 'Test tokens received.' });
      }
    } catch (err) { setPrivateFeedback({ message: errorText(err), error: true }); }
    finally { runningRef.current = false; setRunning(false); setPrivateAction(null); runController.current = null; }
  }

  const executeAction = useCallback(async (script: EvmlScript) => {
    const current = signer.current;
    if (!current) throw new Error("Create a test account first.");
    if (runningRef.current) throw new Error('Another script or wallet operation is running.');
    runningRef.current = true;
    const controller = new AbortController(); runController.current = controller;
    setRunning(true);
    setError("");
    try {
      await script.execute(undefined, {
        prepareChains: false,
        signal: controller.signal,
        handlers: { ...refuseOtherActions(), frame: async (action, ctx) => {
            if (networkId === 'devnet' && privateRuntime.current?.state.pending)
              throw new Error('Inspect the pending private transaction before sending another frame transaction.');
            if (hasPrivateFrames(action)) {
              if (!privateRuntime.current) throw new Error('Private wallet runtime is not ready.');
              return privateRuntime.current.frameHandler(networkId, current)(action, ctx);
            }
            return makeFrameHandler({ networkId, signer: current, onUpdate: record })(action, ctx);
          },
          ...(privateRuntime.current ? { wallet: privateRuntime.current.handler(networkId, current) } : {}) },
      });
    } finally {
      setRunning(false);
      runningRef.current = false; runController.current = null;
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
        <button className="evml-link" disabled={running} onClick={() => void checkNetwork()}>Recheck</button>
        {running && <button className="evml-link" onClick={() => runController.current?.abort()}>Stop after current submission</button>}
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
            <code>frame:tx</code> can combine public calls and private spending commands in one alt-mempool transaction.
            Use <code>batch ( … )</code> inside it for all-or-nothing execution. Keep scans and quotes outside the block.
          </p>
          <p className="evml-hint">
            Run interprets the script and sends each <code>frame:tx</code> as one frame transaction. Calls outside a{" "}
            <code>frame:tx</code> block are refused, and so are <code>frame:new-account</code>, <code>frame:new-sponsor</code> and{" "}
            <code>frame:tx --account</code>: public frame commands use the test key. Private commands use the separate passkey wallet. Body frames
            without <code>--gas</code> or <code>--state-gas</code> get the DeFi app’s EOA budget (600,000 / 1,500,000).
          </p>
        </section>
        <aside className="evml-side">
          {networkId === 'devnet' && <PrivateScriptWalletPanel state={privateState} runtime={privateRuntime.current}
            feedback={privateFeedback} activeAction={privateAction}
            disabled={running || funding || !connected} onTask={action => void privateTask(action)}
            onExample={() => { scriptRef.current = PRIVATE_EXAMPLE; setEditorKey(key => key + 1); }} />}
          <section className="evml-card">
            <h2>Test / relay account <span className="evml-badge">SECP256K1</span></h2>
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
              {networkId === 'devnet' && <>This temporary address submits your private wallet transactions. Your passkey wallet above holds your wallet assets
              and authorizes spending. </>}Public scripts use this test account as <code>@me</code>.
            </p>
            <p className="evml-hint">
              The key stays in this page’s memory: reloading or switching networks replaces the account. Sponsored
              scripts (<code>--paymaster</code>) need no ETH. Use test funds only.
            </p>
            {error && <p className="evml-hint evml-error">{error}</p>}
          </section>
          <section className="evml-card">
            <h2>Sent frame transactions <span className="evml-badge">{sent.length}</span></h2>
            {sent.length === 0 ? (
              <p className="evml-hint">No saved transactions on this network yet.</p>
            ) : (
              <ul className="evml-sent">
                {sent.map((item) => {
                  const state = item.receipt ? (item.receipt.status === "0x1" ? "ok" : "failed") : item.outcome === 'rejected' || item.error ? "failed" : "";
                  const label = item.receipt ? (item.receipt.status === "0x1" ? "Included" : "Reverted") : item.outcome === 'rejected' ? 'Rejected' : item.error ? "Unknown" : "Pending";
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
