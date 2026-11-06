"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { rpc } from "@/lib/rpc";

type Network = {
  status: "checking" | "online" | "offline" | "wrong-chain";
  block: string | null;
  refresh: () => Promise<void>;
};
const Context = createContext<Network>({
  status: "checking",
  block: null,
  refresh: async () => {},
});
export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Network["status"]>("checking");
  const [block, setBlock] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setStatus("checking");
    try {
      const [id, height] = await Promise.all([
        rpc<string>("eth_chainId"),
        rpc<string>("eth_blockNumber"),
      ]);
      if (BigInt(id) !== 1337n) {
        setStatus("wrong-chain");
        setBlock(null);
        return;
      }
      setBlock(BigInt(height).toString());
      setStatus("online");
    } catch {
      setStatus("offline");
      setBlock(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <Context.Provider value={{ status, block, refresh }}>
      {children}
    </Context.Provider>
  );
}
export function useNetwork() {
  return useContext(Context);
}
export function NetworkBadge() {
  const { status, refresh } = useNetwork();
  return (
    <button
      className={`network-badge ${status}`}
      onClick={() => void refresh()}
      title="Check local gateway connectivity"
    >
      <span className="status-dot" />
      {status === "online"
        ? "Local devnet connected"
        : status === "checking"
        ? "Checking devnet"
        : status === "wrong-chain"
        ? "Wrong network"
        : "Local devnet offline"}
      <span className="network-id">1337</span>
    </button>
  );
}
