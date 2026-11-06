import { defineChain, http } from "viem";
import {
  createFrameClient,
  frameNetworks,
  type FrameNetworkId,
} from "@framepay/sdk";

export const chain = defineChain({
  id: 1337,
  name: "Framecraft devnet",
  nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [frameNetworks.devnet.rpcUrl] } },
});
export function frameClient(networkId: FrameNetworkId = "devnet") {
  const network = frameNetworks[networkId];
  return createFrameClient({
    chain: {
      ...chain,
      name: network.name,
      rpcUrls: { default: { http: [network.rpcUrl] } },
    },
    transport: http(`/api/rpc?network=${networkId}`, {
      retryCount: 0,
      timeout: 12_000,
    }),
    profile: "ethrex-eip8141-tracer",
  });
}
export async function rpc<T>(
  method: string,
  params: unknown[] = [],
  networkId: FrameNetworkId = "devnet"
): Promise<T> {
  const response = await fetch(`/api/rpc?network=${networkId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  const body = await response.json();
  if (!response.ok || body.error)
    throw new Error(
      body.error?.message ?? `Gateway request failed (${response.status}).`
    );
  if (body.jsonrpc !== "2.0" || body.id !== 1 || !Object.hasOwn(body, "result"))
    throw new Error("Invalid gateway response.");
  return body.result as T;
}
export const jsonText = (value: unknown) =>
  JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2
  );
export const shortAddress = (value: string) =>
  `${value.slice(0, 6)}…${value.slice(-4)}`;
