const address = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const hash = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const latest = (value) => value === "latest" || value === "pending";
const checks = {
  eth_chainId: (p) => p.length === 0,
  eth_blockNumber: (p) => p.length === 0,
  eth_getBlockByNumber: (p) =>
    p.length === 2 && p[0] === "0x0" && p[1] === false,
  skandha_explorer_info: (p) => p.length === 0,
  eth_getBalance: (p) => p.length === 2 && address(p[0]) && latest(p[1]),
  eth_getCode: (p) => p.length === 2 && address(p[0]) && latest(p[1]),
  eth_getTransactionCount: (p) =>
    p.length === 2 && address(p[0]) && latest(p[1]),
  eth_getTransactionReceipt: (p) => p.length === 1 && hash(p[0]),
  skandha_explorer_getTransaction: (p) => p.length === 1 && hash(p[0]),
  skandha_explorer_faucet: (p) => p.length === 1 && address(p[0]),
  eth_sendFrameTransaction: (p) =>
    p.length === 1 &&
    p[0] &&
    typeof p[0] === "object" &&
    p[0].chainId === "0x539" &&
    address(p[0].sender) &&
    Array.isArray(p[0].frames) &&
    p[0].frames.length > 0 &&
    p[0].frames.length <= 16 &&
    Array.isArray(p[0].signatures) &&
    p[0].signatures.length > 0 &&
    p[0].signatures.length <= 4,
};
export function validateRpcRequest(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.jsonrpc !== "2.0" ||
    !(typeof body.id === "string" || Number.isSafeInteger(body.id)) ||
    !Array.isArray(body.params)
  )
    return false;
  return Object.hasOwn(checks, body.method) && checks[body.method](body.params);
}
export function validateGateway(value, network = "local") {
  try {
    const url = new URL(value);
    if (network === "public")
      return url.href === "https://altmempoolgateway.forshtat.com/rpc";
    if (network !== "local") return false;
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
