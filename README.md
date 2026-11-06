# FramePay SDK

A developer SDK and reference DeFi app designed to bring post-quantum vault authorization, sponsored token transfers, and 1inch Aqua/SwapVM trading to EIP-8141 frame transactions.

The project lets applications offer users a smart-account vault that can authorize actions with a post-quantum key and transfer or trade tokens without holding ETH for gas. An application-funded paymaster covers the network gas cost.

**Status:** Early development. A typed viem SDK, Next.js docs and playground with local/public devnet selection, transfer composition, and deployment tooling are implemented. A test paymaster contract limits each sponsored transaction's maximum cost, with local and public deployments recorded in `config/paymasters.json`. The local explorer reports a three-frame transaction admitted and included with the deployed paymaster as payer; full frame execution results and gas charges remain to be checked. PQ vault authorization, token-fee paymaster adapters, and Aqua integration are planned.

## What the kit provides

- **Post-quantum vault authorization:** account-controlled verification of a user's PQ signature.
- **Sponsored token transfers and trading:** ERC-20 operations funded by a paymaster with explicit sponsorship limits.
- **Atomic application operations:** same-chain action groups designed to complete together or revert their application state changes.
- **Aqua/SwapVM integration:** a recurring, partially fillable buy position with price, spending, and expiry limits.
- **Developer SDK:** a shared interface for preparing, signing, simulating, submitting, and tracking frame transactions.
- **Developer documentation and playground:** searchable API guides and an interactive prepare, sign, submit, and inspect workflow for local frame transactions.
- **Transfer composer:** generate EOA ETH-transfer frames from user choices, check local draft limits, and review the requested gas payer before signing. A selected paymaster must independently approve sponsorship.
- **Reference vault app:** a user-facing demonstration of the SDK's transfer and trading flows.

## How the pieces fit

The vault holds assets and enforces authorization. EIP-8141 supplies the native account and payment framework, while the alternative mempool handles submission under its admission rules. The paymaster sponsors gas, and Aqua with customized SwapVM logic executes the trading position.

Post-quantum protection applies to the intended vault authorization path. It does not itself encrypt pending transactions.

Implementation details, tasks, decisions, and the development record are maintained in [plan.md](plan.md).

## Monorepo layout

This uses the common `apps/` + `packages/` convention, with a top-level Foundry
project for Solidity. Bun installs and links workspaces; Lerna runs their tasks
in dependency order. The web app depends on the SDK through `workspace:*`.

```text
framepay/
├── apps/
│   └── web/                 # Next.js docs and playground (@framepay/docs)
├── packages/
│   └── sdk/                 # Shared TypeScript SDK (@framepay/sdk)
├── contracts/               # Foundry workspace (@framepay/contracts)
│   ├── src/                 # Solidity contracts
│   ├── test/                # Solidity tests (*.t.sol)
│   ├── artifacts/           # Reviewed deployment artifacts
│   └── foundry.toml         # Compiler and EVM settings
├── examples/                # SDK usage examples, checked during builds
├── tests/                   # Cross-package JavaScript tests
├── scripts/                 # Development and deployment tooling
├── config/                  # Shared network and deployment configuration
├── .husky/                  # Commit and push hooks
├── .github/workflows/       # CI
├── bun.lock                 # Single dependency lockfile
├── lerna.json
└── nx.json                  # Build dependency ordering; task cache disabled
```

Add deployable applications under `apps/` and reusable libraries under
`packages/` (for example, `packages/ui` when shared components are needed).
Keep Solidity sources and tests together in `contracts/`. Add `contracts/script/`
for Foundry deployment scripts or `contracts/lib/` when Solidity dependencies
are introduced. Build output (`dist/`, `.next/`, `contracts/out/`) stays ignored.

## Development setup

Install Node.js 24 (`nvm install`), Bun 1.3.6, and Foundry v1.5.0. Node is still
required by Next.js, Lerna, and the existing Node scripts. Foundry manages the
Solidity 0.8.33 compiler pinned in `contracts/foundry.toml`; its first build needs
network access to download that compiler.

```sh
# With Foundry's foundryup installer already available:
foundryup --install v1.5.0
bun install
bun run build
bun run dev
```

`bun install` creates workspace links and activates Husky automatically. Commit
`bun.lock`; use `bun install --frozen-lockfile` in CI and reproducible checkouts.
Use Bun for dependency changes; do not create npm or Yarn lockfiles.

| Command | Purpose |
| --- | --- |
| `bun run dev` | Build SDK, then start the web development server |
| `bun run build` | Build all three workspaces and check examples |
| `bun run web:build` | Build the SDK dependency and the web app |
| `bun run sdk:build` | Build the SDK only |
| `bun run contracts:build` | Compile Solidity with Foundry |
| `bun run contracts:test` | Run Foundry contract tests |
| `bun run contracts:fmt` | Format Solidity |
| `bun run web:typecheck` | Build SDK and check web TypeScript |
| `bun run test` | Run existing JavaScript tests (requires the pinned sibling workshop checkout) |
| `bun run check:push` | Run the same full build gate as the push hook and CI |

The existing devnet tests verify a separately provisioned `mempool-workshop`
checkout and its recorded fingerprints; the build and contract-test CI job does
not require a running devnet or that sibling repository.

## Git checks

- **Pre-commit:** rejects whitespace errors in staged changes.
- **Pre-push:** runs `bun run check:push`. A failed SDK build, web production
  build, Solidity build, or example type check blocks the push. Every workspace
  runs each time; Lerna/Nx task-result caching is disabled. TypeScript and Foundry
  may still use their own incremental compiler state.
- **CI:** repeats the full build from the checked-out commit with a frozen
  lockfile, then runs contract tests on pull requests and pushes to `main`.

Local hooks build your working tree and can be bypassed by Git options. For
server-side enforcement, configure the GitHub `main` branch ruleset to require
pull requests and the **Build all workspaces** status check before merging.
The workflow is included here; repository branch protection must be enabled in
GitHub settings. Keep the working tree aligned with the commits you push.
