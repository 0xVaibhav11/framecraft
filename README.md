# FramePay SDK

A developer SDK and reference DeFi app designed to bring post-quantum vault authorization, sponsored token transfers, and 1inch Aqua/SwapVM trading to EIP-8141 frame transactions.

The project lets applications offer users a smart-account vault that can authorize actions with a post-quantum key and transfer or trade tokens without holding ETH for gas. An application-funded paymaster covers the network gas cost.

**Status:** In design; implementation has not started.

## What the kit provides

- **Post-quantum vault authorization:** account-controlled verification of a user's PQ signature.
- **Sponsored token transfers and trading:** ERC-20 operations funded by a paymaster with explicit sponsorship limits.
- **Atomic application operations:** same-chain action groups designed to complete together or revert their application state changes.
- **Aqua/SwapVM integration:** a recurring, partially fillable buy position with price, spending, and expiry limits.
- **Developer SDK:** a shared interface for preparing, signing, simulating, submitting, and tracking frame transactions.
- **Reference vault app:** a user-facing demonstration of the SDK's transfer and trading flows.

## How the pieces fit

The vault holds assets and enforces authorization. EIP-8141 supplies the native account and payment framework, while the alternative mempool handles submission under its admission rules. The paymaster sponsors gas, and Aqua with customized SwapVM logic executes the trading position.

Post-quantum protection applies to the intended vault authorization path. It does not itself encrypt pending transactions.

Implementation details, tasks, decisions, and the development record are maintained in [plan.md](plan.md).
