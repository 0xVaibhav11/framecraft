# Private payments and maker inventory

FramePay ports `private-poc-bundle` into a Foundry contract project and the Node-oriented `@framepay/privacy` TypeScript workspace. New implementation, tooling, and tests use TypeScript and Solidity. Effect services separate proof generation, RPC access, and frame submission. The existing public DeFi app remains the public trading interface; this integration is available through the package and devnet demo CLI.

## Bundle analysis and implementation map

| Bundle component | FramePay implementation |
| --- | --- |
| RAILGUN V2 ABI and atomic settlement | `contracts/src/IRailgun.sol`, `FramePayPrivateSettlement.sol` |
| Restricted real SwapVM router | `contracts/private/src/FramePayPrivateSwapVM.sol` |
| solc JavaScript compiler driver | Foundry, pinned native Solidity 0.8.30, Cancun, via-IR, optimizer runs 1 |
| Wallet derivation, encryption and scanning | `packages/privacy/src/wallet.ts`, `tree.ts`, `engine.ts` |
| Groth16 circuit and spending proofs | `prover.ts`, `scripts/private/artifacts.ts` |
| Conditional private swap | `settlement.ts`, `PrivateProver` Effect service |
| Native frame envelope and receipt checks | `frames.ts`, using the existing `@framepay/sdk` |
| Deployment, scenario and reports | `scripts/private/*.ts` |
| Public original RAILGUN creation artifacts and verification keys | `config/private/railgun/`, checked by `sources.json` |

The router inherits the same real SwapVM revision as the bundle and FramePay's public integration: `f9f4acfed0ffa321c2108efe05ecf7a5e0bd8abc`. Its public instruction set contains StaticBalances and XYCSwap to fit EIP-170. The private entry point verifies two proof-bound payments and calls unchanged RAILGUN once. Aqua is deployed unchanged and is outside private settlement. The private project pins Aqua 1.0.1, matching the bundle; this dependency is isolated from the public Aqua workspace.

Each spending proof binds the adapter, chain, pool, trade identifier, deadline, and both expected payment commitments. The domain is now `FramePay.PrivateSwap.v1`, so old bundle quotes are intentionally incompatible. The contract forbids unshielding through the swap entry point. RAILGUN verifies proofs and rejects spent nullifiers. A failure in either leg reverts both spends.

## Setup and run

Use the repository's Bun and Node versions, Foundry 1.5.0, and native solc 0.8.30. Foundry downloads its compiler on first use. `FRAMEPAY_PRIVATE_SOLC=/absolute/path/to/solc` optionally selects an already installed native compiler.

```sh
bun install --frozen-lockfile
bun run private:setup
bun run private:test
bun run private:contracts:test
bun run private:test:proofs

# Requires a frame-enabled gateway and faucet on chain 1337.
FRAMEPAY_PRIVATE_RPC=https://psi-essential-rebate-wrist.trycloudflare.com/rpc bun run private:demo
bun run private:report
```

Setup downloads the pinned SwapVM and Solidity source archives and published RAILGUN 1-input/2-output circuit artifacts. SHA-256 checks protect downloads and existing files. The wasm and zkey hashes are the bundle's published RAILGUN hashes; the verification-key JSON is pinned to the bundled copy. Source-tree checks reject a modified dependency checkout. Setup does not deploy contracts or send transactions.

The demo defaults to localhost on chain 1337. Setting `FRAMEPAY_PRIVATE_RPC` explicitly permits a remote HTTPS gateway; remote runs additionally verify FramePay devnet’s pinned genesis hash. HTTP remote URLs, URL credentials, and redirects are rejected. The user-provided gateway above was checked against that genesis. It creates disposable local keys, funds them through the gateway faucet, and resumes its own deployment journal. It does not import the bundle's deployment state or wallet keys. A lock prevents concurrent demo processes sharing nonces. If a process dies, inspect the recorded PID before removing its stale `run.lock`. After resetting the chain, archive the entire runtime directory before deploying again. Do not reuse its journal against another chain.

The demo performs:

1. Public shield deposits, checking RAILGUN's 0.25% fee.
2. Private maker-to-taker transfer, recipient scanning, and outsider isolation.
3. Private addition of 1,000 A and 2,000 B to a separate maker-controlled quoting wallet.
4. A two-party swap: 500 B for 200 A using the local exact-in XYCSwap formula.
5. Private return of remaining inventory and proceeds to the maker wallet.
6. Public unshield, including an explicit net-of-fee token balance check against a recipient distinct from the treasury.

For internal transfers it checks that calldata contains neither test-token address, emits no ERC-20 Transfer logs, and leaves pool backing unchanged. It checks replay, isolated/missing legs, modified payment conditions, expired swaps, invalid proofs, and mined atomic rollback. Each successful submission must have native type 0x06, both frame receipts, and sidecar admission evidence. It never retries a transaction automatically.

Private runtime data lives under ignored `.framepay/private/runtime/` with private directory/file permissions. The run intentionally stores disposable wallet mnemonics there for recovery. Reports live under `.framepay/private/reports/`, with a separate JSON record per run and receipts saved before balance assertions; balances in those reports are deliberately disclosed test data. A failed or incomplete run cannot generate a passing verification report.

## Using Effect

`PrivateProver`, `PrivateRpc`, and `PrivateSubmitter` are injectable Effect services. Library callers opt into a remote endpoint with `makeRpcClient(url, fetch, { allowRemote: true })` and can enforce the genesis with `requireDevnetChain(rpc, expectedGenesis)`. `preparePrivateTransfer` and `preparePrivateSwap` prepare proof-bound calldata; `privateTransfer` combines preparation and submission. Moving inventory to or from a maker's quoting wallet is an ordinary private transfer. `PrivateProverLive` uses the real engine and snarkjs; replacing a service is useful for application tests.

```ts
import { Effect, Layer } from 'effect';
import {
  PrivateProverLive, PrivateSubmitterLive, privateTransfer,
} from '@framepay/privacy';

const services = Layer.mergeAll(
  PrivateProverLive(verifiedCircuitArtifacts),
  PrivateSubmitterLive(localRpcClient, disposableSubmitterKey),
);

const receipt = await Effect.runPromise(
  privateTransfer(pool, makerWallet, recipientWallet, token, amount)
    .pipe(Effect.provide(services)),
);
```

Synchronize the tree and scan the wallet before selecting inputs, and rescan after inclusion. The current circuit supports one input and two outputs; fragmented balances require separate transfers. The index rebuilds one 65,536-note tree and checks its root at the same block as its event snapshot. It rejects tree rollover. It is a local test index, not a persistent multi-chain wallet synchronizer. The engine's unexported APIs are contained in one typed compatibility module pinned to engine 9.9.1.

## Verification layers and scope

- `private:test`: TypeScript type checking, quote/domain boundaries, RPC response validation and error redaction, receipt handling, real shield-note decryption/isolation, and Effect failure paths.
- `contracts:test`: settlement guard and atomic rollback tests against an explicitly labeled pool model, plus existing paymaster tests.
- `private:contracts:test`: the above settlement tests and real SwapVM runtime-size checks.
- `private:test:proofs`: Foundry deploys the original RAILGUN creation artifacts, registers the real verification key, and uses TypeScript through explicit `--ffi` to generate real Groth16 transfer and swap proofs. It checks real pool roots, fees, replay, isolated legs, invalid-proof rollback, and unchanged backing. This needs no running RPC server and does not exercise native frame opcodes.
- `private:demo`: full native-frame and sidecar integration against the separate gateway. A normal Anvil node cannot run this envelope.

“Private liquidity” means maker-owned quote inventory. It has no pooled LP shares, persistent hidden AMM invariant, locked reservations, or offline standing orders. Both parties must authorize the exact outputs. The public submitter pays gas. Deposits, withdrawals, transaction shapes, timing, and a small anonymity set expose context. POI, remote encrypted quoting, production key storage, reorg recovery, post-quantum private spending, and security audit work remain outside the bundle's scope and this port.
