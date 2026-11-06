# FramePay SDK

A developer SDK and reference DeFi app designed to bring post-quantum vault authorization, sponsored token transfers, and 1inch Aqua/SwapVM trading to EIP-8141 frame transactions.

The project lets applications offer users a smart-account vault that can authorize actions with a post-quantum key and transfer or trade tokens without holding ETH for gas. An application-funded paymaster covers the network gas cost.

**Status:** The app defaults to FramePay devnet at `https://undertaken-decide-gathered-epic.trycloudflare.com/rpc` (chain 1337, with its own genesis). It supports PRF-derived ETHFalcon wallets, Aqua/SwapVM swaps, sponsored transfers and recurring positions. Deployment addresses are in `config/`. Generated run reports stay in ignored `.framepay/reports/`; the repository does not track evidence dumps. Token-fee reimbursement remains planned.

Open **[the DeFi app](http://localhost:3000/app)** with `npm run web:dev`. Create a quantum wallet with a PRF-capable passkey (or a disposable test account), get test tokens, then use **Swap**, **Transfer**, **Positions**, and **Rules**. See [the app guide](docs/defi-app.md) for contract setup and the assertion model. The app uses devnet test assets and supports both passkey smart wallets and disposable browser test accounts. See [the quantum wallet guide](docs/quantum-wallet.md) for ETHFalcon setup and PRF key derivation, or [the legacy passkey wallet guide](docs/passkey-wallet.md) for existing P-256 accounts.

Run the contract tests with `npm run aqua:test` and the swap demo with `npm run aqua:demo` after [Aqua setup](docs/aqua-recurring-buy.md). The guide includes source pins, deployment details, strategy rules and verification commands.

## What the kit provides

- **Post-quantum vault authorization:** account-controlled verification of a user's PQ signature.
- **Sponsored token transfers and trading:** ERC-20 operations funded by a paymaster with explicit sponsorship limits.
- **Atomic application operations:** same-chain action groups designed to complete together or revert their application state changes.
- **Aqua/SwapVM integration:** a recurring, partially fillable buy position with price, spending, and expiry limits.
- **Developer SDK:** a shared interface for preparing, signing, simulating, submitting, and tracking frame transactions.
- **Developer documentation and playground:** searchable API guides and an interactive prepare, sign, submit, and inspect workflow for devnet frame transactions.
- **Transfer composer:** generate EOA ETH-transfer frames from user choices, check local draft limits, and review the requested gas payer before signing. A selected paymaster must independently approve sponsorship.
- **Reference vault app:** a user-facing demonstration of the SDK's transfer and trading flows.

## How the pieces fit

The vault holds assets and enforces authorization. EIP-8141 supplies the native account and payment framework, while the alternative mempool handles submission under its admission rules. The paymaster sponsors gas, and Aqua with customized SwapVM logic executes the trading position.

Post-quantum protection applies to the intended vault authorization path. It does not itself encrypt pending transactions.

Implementation and setup guides: [DeFi app](docs/defi-app.md), [recurring swaps](docs/aqua-recurring-buy.md), and [ETHFalcon wallets](docs/quantum-wallet.md).
