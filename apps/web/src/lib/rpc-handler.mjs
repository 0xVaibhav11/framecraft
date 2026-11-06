import { validateGateway, validateRpcRequest } from "./rpc-policy.mjs";
import { frameNetworks } from "@framepay/sdk";

function failure(id, code, message, status) {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { status, headers: { "cache-control": "no-store" } }
  );
}
export async function handleRpc(
  request,
  {
    gateway: localGateway = String(frameNetworks.local.rpcUrl),
    fetchImpl = fetch,
  } = {}
) {
  const networkId = new URL(request.url).searchParams.get("network") ?? "devnet";
  if (!Object.hasOwn(frameNetworks, networkId))
    return failure(null, -32600, "Unknown frame network.", 400);
  const network = frameNetworks[networkId];
  const gateway = networkId === "local" ? localGateway : network.rpcUrl;
  const origin = request.headers.get("origin");
  const requestUrl = new URL(request.url);
  let sameOrigin = !origin || origin === requestUrl.origin;
  // Next dev may canonicalize 127.0.0.1 to localhost in request.url. Accept the original
  // loopback host only when the browser Origin matches the actual Host header and port.
  if (origin && !sameOrigin) {
    try {
      const source = new URL(origin);
      const loopback = value => ["localhost", "127.0.0.1", "[::1]"].includes(value);
      sameOrigin = loopback(source.hostname) && loopback(requestUrl.hostname)
        && source.protocol === "http:" && requestUrl.protocol === "http:"
        && source.port === requestUrl.port && source.host === request.headers.get("host");
    } catch { /* Invalid origins remain rejected. */ }
  }
  if (!sameOrigin)
    return failure(
      null,
      -32600,
      "Cross-origin RPC requests are not allowed.",
      403
    );
  if (!request.headers.get("content-type")?.includes("application/json"))
    return failure(null, -32600, "Use application/json.", 415);
  if (Number(request.headers.get("content-length")) > 65_536)
    return failure(null, -32600, "Request is too large.", 413);
  let body;
  try {
    const reader = request.body?.getReader();
    if (!reader) return failure(null, -32700, "Missing JSON body.", 400);
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        return failure(null, -32600, "Request is too large.", 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return failure(null, -32700, "Invalid JSON.", 400);
  }
  if (!validateRpcRequest(body))
    return failure(
      body?.id,
      -32600,
      "This request is not supported by the playground.",
      400
    );
  if (!validateGateway(gateway, networkId))
    return failure(
      body.id,
      -32603,
      "Configure a loopback HTTP gateway in FRAMEPAY_RPC_URL.",
      503
    );
  try {
    const response = await fetchImpl(gateway, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok)
      return failure(
        body.id,
        -32000,
        `${network.name} gateway returned HTTP ${response.status}.`,
        502
      );
    const result = await response.json();
    if (!result || result.jsonrpc !== "2.0" || result.id !== body.id)
      return failure(
        body.id,
        -32603,
        "Invalid response from the selected gateway.",
        502
      );
    if (result.error) {
      const code = Number.isSafeInteger(result.error.code)
        ? result.error.code
        : -32000;
      return failure(
        body.id,
        code,
        `Gateway rejected ${body.method} (RPC ${code}). Inspect the transaction admission report for rule details.`,
        200
      );
    }
    if (!Object.hasOwn(result, "result"))
      return failure(
        body.id,
        -32603,
        "Missing result from the selected gateway.",
        502
      );
    return Response.json(
      { jsonrpc: "2.0", id: body.id, result: result.result },
      {
        headers: { "cache-control": "no-store" },
      }
    );
  } catch {
    return failure(
      body.id,
      -32000,
      networkId === "devnet"
        ? "FramePay devnet gateway unavailable. Check the configured Cloudflare tunnel."
        : networkId === "local"
        ? "Local gateway unavailable. Start the devnet and check port 14337."
        : "Public devnet gateway unavailable. Check connectivity and try again.",
      503
    );
  }
}
