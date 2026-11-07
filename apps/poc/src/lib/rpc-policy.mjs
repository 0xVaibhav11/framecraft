import { frameNetworks } from "@framepay/sdk";

const address = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const hash = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const latest = (value) => value === "latest" || value === "pending";
const blockNumber = (value) => typeof value === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/.test(value);
const hexData = (value) => typeof value === "string" && value.length <= 65_538 && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
const checks = {
  eth_chainId: (p) => p.length === 0,
  eth_blockNumber: (p) => p.length === 0,
  eth_getBlockByNumber: (p) =>
    p.length === 2 && ["0x0", "latest"].includes(p[0]) && p[1] === false,
  eth_getLogs: (p) => p.length === 1 && p[0] && !Array.isArray(p[0])
    && Object.keys(p[0]).every(key => ["address", "fromBlock", "toBlock"].includes(key))
    && address(p[0].address) && blockNumber(p[0].fromBlock) && blockNumber(p[0].toBlock)
    && BigInt(p[0].toBlock) >= BigInt(p[0].fromBlock) && BigInt(p[0].toBlock) - BigInt(p[0].fromBlock) <= 100000n,
  eth_call: (p) => p.length === 2 && (p[1] === "latest" || blockNumber(p[1])) && p[0] && !Array.isArray(p[0])
    && Object.keys(p[0]).every(key => ["to", "data", "from"].includes(key))
    && address(p[0].to) && hexData(p[0].data) && (p[0].from === undefined || address(p[0].from)),
  skandha_explorer_info: (p) => p.length === 0,
  eth_getBalance: (p) => p.length === 2 && address(p[0]) && latest(p[1]),
  eth_getCode: (p) => p.length === 2 && address(p[0]) && latest(p[1]),
  eth_getTransactionCount: (p) =>
    p.length === 2 && address(p[0]) && latest(p[1]),
  eth_getTransactionReceipt: (p) => p.length === 1 && hash(p[0]),
  eth_getTransactionByHash: (p) => p.length === 1 && hash(p[0]),
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
    if (network === "devnet" || network === "public")
      return url.protocol === "https:" && url.href === frameNetworks[network].rpcUrl;
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
