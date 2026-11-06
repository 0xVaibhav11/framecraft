import { parseAbi, type Address, type Hex } from "viem";

export type Order = { maker: Address; traits: bigint; data: Hex };
export type StoredOrder = { maker: Address; traits: string; data: Hex };
export type Position = { name: string; order: StoredOrder; orderHash: Hex; policy: {
  buyToken: Address; schedule: string; periodBudget: string; totalBudget: string;
  buyUnits: string; spendUnits: string; salt: Hex;
} };
export type AppDeployment = { network: "local"; genesisHash: Hex;
  contracts: Record<"aqua" | "router" | "guard" | "usd" | "asset", Address>;
  codeHashes: Record<string, Hex>; seedPosition: Position;
};
export const unpackOrder = (order: StoredOrder): Order => ({ ...order, traits: BigInt(order.traits) });
export const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function claimed(address) view returns (bool)",
  "function claim()",
]);
export const aquaAbi = parseAbi([
  "function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)",
  "function dock(address app, bytes32 strategyHash, address[] tokens)",
  "function safeBalances(address maker,address app,bytes32 strategyHash,address token0,address token1) view returns (uint256,uint256)",
]);
export const swapAbi = parseAbi([
  "struct Order { address maker; uint256 traits; bytes data; }",
  "struct Policy { address buyToken; uint256 schedule; uint128 periodBudget; uint128 totalBudget; uint128 buyUnits; uint128 spendUnits; bytes32 salt; }",
  "function buildOrder(address maker,address spendToken,Policy policy) pure returns (Order)",
  "function buildTakerData(address buyToken,address spendToken,uint256 maxInput,uint40 deadline) pure returns (bytes)",
  "function hash(Order order) view returns (bytes32)",
  "function usage(bytes32 orderHash) view returns (uint256 epoch,uint256 periodSpent,uint256 totalSpent)",
  "function quote(Order order,uint256 amount,bytes takerTraitsAndData) view returns (uint256 amountIn,uint256 amountOut,bytes32 orderHash)",
  "function swap(Order order,uint256 amount,bytes takerTraitsAndData) payable returns (uint256,uint256,bytes32)",
]);
export const guardAbi = parseAbi([
  "function transferToken(address token,address recipient,uint256 amount,uint256 maximum,uint256 minimumReceived,uint256 deadline)",
  "function transferNative(address recipient,uint256 maximum,uint256 deadline) payable",
]);
