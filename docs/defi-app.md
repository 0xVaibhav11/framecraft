# FramePay DeFi app

Open **http://localhost:3000/app**. The app performs real type-`0x06` transactions on the local frame devnet using the FramePay SDK, official Aqua settlement, the customized recurring-buy SwapVM, and the FramePay test paymaster.

## Try it

1. Select **Local devnet**, then **Create passkey wallet** and **Deploy wallet**, or choose **Use a disposable test account**. See [the passkey guide](passkey-wallet.md).
2. Click **Get test tokens** and confirm the review. This sponsored transaction claims 1,000 fpUSD and 100 fpASSET. The account can hold zero ETH.
3. In **Swap**, choose a liquidity position and the exact fpUSD amount to receive. Review the fpASSET input, assertions, and gas payer, then confirm.
4. In **Transfer**, enter a different recipient and an fpUSD amount. Keep the paymaster selected to sponsor gas. ETH transfers are also supported; the account must own the ETH it sends.
5. In **Rules**, lower the transfer cap and try an amount above it. The app rejects the draft before signing. Adjust the cap to permit the transfer and try again.
6. In **Positions**, create a recurring fpASSET buy with an fpUSD budget, per-period allowance, fixed price, and expiry. Share its order JSON with another account, which can import and fill it. Cancel to stop further fills.

Every write has an explicit review. Recent activity links to the local explorer, and confirmation requires successful receipts for every frame. If inclusion times out, the app saves the hash and blocks another submission until receipt inspection resolves it.

The community position starts with 1,000 fpUSD, buys at 10 fpUSD per fpASSET, permits 100 fpUSD of fills per minute, and expires after 30 days. Capacity is finite and unused period capacity does not carry over. A recurring position makes liquidity available on a schedule; fills still require a taker transaction. There is no automatic buying bot.

## What the assertions enforce

| Setting | Enforcement |
| --- | --- |
| Maximum fpUSD or ETH transfer | Checked before signing and passed to the onchain transfer guard |
| Transfer recipient allowlist | Browser preference checked before signing; the selected recipient is signed into the call |
| Full token delivery | Transfer guard checks the recipient's balance increase and reverts the token movement if it is too small |
| Maximum swap input and minimum output | Browser checks the quote; SwapVM executes the exact output with an input cap included in the signed call |
| Transaction expiry | Transfer guard or SwapVM rejects an expired transfer/swap |
| Require sponsorship | Browser prevents self-paid swap, transfer, or position creation; the paymaster independently approves payment |
| Recurring period budget, lifetime budget, price and expiry | Enforced by the recurring SwapVM program during each fill |

Rules persist in this browser for the selected deployment. These are editable preferences and assertions for individual signed calls, not persistent smart-account permissions. The account owner can sign different limits later or transact outside the app. Recurring-position limits are fixed at creation; cancel and create another position to change them.

Token approvals and application calls can occupy separate frames. A failed application frame can leave an earlier approval in place. Approvals created by the app use the reviewed amount. Multiple recurring positions share the maker's Aqua allowance and token balance; creating a position updates that shared allowance to the new position's budget.

## Devnet setup

The default RPC is the configured Cloudflare devnet. Complete the SDK/web dependency setup in the quickstart, then run:

```sh
npm run aqua:bootstrap
npm run aqua:build
npm run paymaster:deploy -- --network devnet
npm run defi:deploy -- --network devnet
npm run quantum:build
npm run quantum:deploy -- --network devnet
npm run web:dev
```

`defi:deploy` deploys the official Aqua contract, the customized SwapVM router, the transfer guard, and two claimable test tokens. It seeds the community position and writes `config/defi.json`. The private deployment journal is resumable; public deployment evidence is written under ignored `.framepay/reports/aqua/`. See [the Aqua guide](aqua-recurring-buy.md) for source pins and the canonical frame path needed by the large router deployment. Normal app transactions use the standard alternative mempool.

The app checks the genesis and deployed code hashes, including the paymaster. The configured environments share chain ID 1337, so chain ID alone is insufficient. The Cloudflare network has its own deployment records and account storage. A changed genesis requires reviewing and regenerating those records.

The `.mjs` files are JavaScript modules run by Node.js for setup, deployment, and verification. The onchain logic is Solidity; the screen is React/TypeScript.

## Account and persistence

Quantum wallets hold assets in a contract and verify only ETHFalcon signatures onchain. Passkey PRF regenerates the Falcon key in browser memory; only public wallet metadata is persisted or exported. The browser also keeps a replaceable relay key to submit sponsored envelopes. See [authorization and recovery details](quantum-wallet.md).

The optional disposable-account flow creates a SECP256K1 test account and keeps its private key in this tab's `sessionStorage`. Reloading retains it; closing the tab can remove it. **Export test account** downloads a private-key file; **Import test account** restores a matching network-and-genesis export. Keep exports private. Positions, public transaction hashes, and rules use `localStorage`. The key is not sent to the app server. This is a disposable test account flow. Use a quantum wallet for ETHFalcon authorization; injected-wallet frame signing remains a future integration.

## Verification

- Browser execution: sponsored token claim, swap, guarded token transfer, position creation and cancellation; five successful type-`0x06` receipts with every frame successful.
- Browser assertions: an oversized transfer was rejected before submission; rules and account survived a reload; the 390-pixel layout had no horizontal overflow or runtime errors.
- Final test-account balances: **1,005 fpUSD, 99 fpASSET, 0 ETH**, after receiving 10 fpUSD for 1 fpASSET and transferring 5 fpUSD.
- `npm test` verifies SDK behavior, rule validation, RPC policy and proxy handling. `npm run aqua:test` verifies recurring-position limits and transfer-guard assertions, including rollback after a failed recipient-balance check. `npm run web:build` builds the app.
