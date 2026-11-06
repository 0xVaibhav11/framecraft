"use client";
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { frameNetworks, type FrameNetworkId } from "@framepay/sdk";
import { rpc } from "@/lib/rpc";

type Network = {
  id: FrameNetworkId;
  status: "checking" | "online" | "offline" | "wrong-chain";
  block: string | null;
  locked: boolean;
  setLocked: (locked: boolean) => void;
  select: (id: FrameNetworkId) => void;
  refresh: () => Promise<void>;
};
const Context = createContext<Network>({
  id: "local",
  status: "checking",
  block: null,
  locked: false,
  setLocked: () => {},
  select: () => {},
  refresh: async () => {},
});
export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [id, setId] = useState<FrameNetworkId>("local");
  const [status, setStatus] = useState<Network["status"]>("checking");
  const [block, setBlock] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++generation.current;
    setStatus("checking");
    try {
      const [chainId, height] = await Promise.all([
        rpc<string>("eth_chainId", [], id),
        rpc<string>("eth_blockNumber", [], id),
      ]);
      if (token !== generation.current) return;
      if (BigInt(chainId) !== BigInt(frameNetworks[id].chainId)) {
        setStatus("wrong-chain");
        setBlock(null);
        return;
      }
      setBlock(BigInt(height).toString());
      setStatus("online");
    } catch {
      if (token !== generation.current) return;
      setStatus("offline");
      setBlock(null);
    }
  }, [id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const select = (next: FrameNetworkId) => {
    if (locked || next === id) return;
    generation.current++;
    setStatus("checking");
    setBlock(null);
    setId(next);
  };
  return (
    <Context.Provider
      value={{ id, status, block, locked, setLocked, select, refresh }}
    >
      {/* Distinct chain histories share 1337: never carry drafts, keys or hashes across environments. */}
      <Fragment key={id}>{children}</Fragment>
    </Context.Provider>
  );
}
export function useNetwork() {
  return useContext(Context);
}
export function NetworkBadge() {
  const network = useNetwork();
  return (
    <div className="network-controls">
      <select
        aria-label="Frame network"
        title="Switching clears the page's disposable account and draft. Reset a prepared draft before switching."
        value={network.id}
        disabled={network.locked}
        onChange={(event) =>
          network.select(event.target.value as FrameNetworkId)
        }
      >
        <option value="local">Local devnet</option>
        <option value="public">Public alt-mempool devnet</option>
      </select>
      <button
        className={`network-badge ${network.status}`}
        onClick={() => void network.refresh()}
        title="Check selected gateway connectivity"
      >
        <span className="status-dot" />
        {network.status === "online"
          ? "Connected"
          : network.status === "checking"
          ? "Checking"
          : network.status === "wrong-chain"
          ? "Wrong chain"
          : "Offline"}
        <span className="network-id">1337</span>
      </button>
    </div>
  );
}
