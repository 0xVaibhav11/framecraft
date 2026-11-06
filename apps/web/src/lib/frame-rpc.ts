// Talks to a FramePay network's gateway straight from the browser (the
// gateways answer CORS requests). The poc app relays through its own server
// instead; this site is static.
import { createFrameClient, frameNetworks, type FrameNetworkId } from "@framepay/sdk";
import { defineChain, http } from "viem";

export function chainOf(networkId: FrameNetworkId) {
  const network = frameNetworks[networkId];
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [network.rpcUrl] } },
  });
}

export const transportOf = (networkId: FrameNetworkId) =>
  http(frameNetworks[networkId].rpcUrl, { retryCount: 0, timeout: 12_000 });

export function frameClient(networkId: FrameNetworkId) {
  return createFrameClient({ chain: chainOf(networkId), transport: transportOf(networkId), profile: "ethrex-eip8141-tracer" });
}

export async function rpc<T>(networkId: FrameNetworkId, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(frameNetworks[networkId].rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error?.message ?? `Gateway request failed (${response.status}).`);
  if (body.jsonrpc !== "2.0" || body.id !== 1 || !Object.hasOwn(body, "result")) throw new Error("Invalid gateway response.");
  return body.result as T;
}

export const shortHex = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
