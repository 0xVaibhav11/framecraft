# ETHFalcon wallet

The quantum wallet has one immutable **ETHFalcon public key as its sole spending authority**. WebAuthn/P-256 signatures are not submitted to or verified by this wallet. Existing P-256 wallets remain separate accounts.

1. Register a PRF-capable passkey, with user verification required.
2. Request WebAuthn PRF with `keccak256("FramePay.ETHFALCON.v1")` as its input salt. The same credential and input reproduce the same 32-byte output. WebAuthn applies its own domain separation; this is not a guarantee about a particular Secure Enclave implementation.
3. Transfer the PRF output to an isolated worker. Pinned ETHFalcon C code deterministically generates the Falcon keypair. Save only public wallet metadata.
4. Deploy `FramePayQuantumWallet` through `FramePayQuantumFactory`. The address binds the Falcon key, verifier, genesis domain and deployment salt.
5. For each reviewed batch, authenticate again, regenerate the key, and sign the challenge. The worker wipes its seed and entire accessible WASM memory, then terminates. JavaScript cannot guarantee erasure of all runtime/hardware copies or a fixed 10 ms lifetime.
6. The wallet checks only ETHFalcon, nonce, expiry and batch bounds, then executes the calls atomically. The signed challenge binds every target, value and calldata, plus wallet address, chain ID, genesis domain, nonce and expiry.

The browser rejects missing PRF support or a regenerated key that differs from the saved owner. A metadata export contains no seed/private key; restoring it also requires a credential that reproduces the same PRF output. Synced passkey behavior depends on the provider. There is no recovery key, administrator or upgrade path.

## Frames

The current integration uses three EIP-8141 frames: relay execution approval, paymaster payment approval, and a SENDER frame calling `wallet.execute()`. The **Falcon signature authorizes the wallet batch**. The disposable relay signs the outer envelope using SECP256K1 and has no independent wallet spending authority. Falcon verification is an internal contract call, not a native Falcon VERIFY frame. Swaps still settle through official 1inch Aqua/SwapVM; sponsored transfers still use the transfer guard.

## Reproduce

ETHFalcon source and C fingerprints are pinned in `config/ethfalcon.json` and `config/aqua-sources.json`. The algorithm is upstream's ETHFalcon-512 Keccak variant, not the SHAKE-based NIST Falcon variant. The bundled upstream JavaScript is deliberately not used: our source build sets `ETHFALCON=1` and replaces the test RNG with Web Crypto.

```sh
npm run aqua:bootstrap
# Install and activate Emscripten 3.1.74 using emsdk, then put emcc on PATH
FRAMEPAY_EMCC=emcc npm run quantum:build
npm run aqua:build
npm test
npm run aqua:test
npm run quantum:browser-check
npm run poc:build
```

`aqua:test` uses Foundry FFI to run the real compiled signer with a public test seed. `quantum:browser-check` needs Bun, Playwright (or the sibling workshop installation), and Chrome; it uses a disposable virtual authenticator, checks PRF regeneration across reloads, and never exports its private credential.

With the configured FramePay devnet producing blocks:

```sh
npm run quantum:deploy -- --network devnet
npm run poc:dev
```

Deploy records are saved in `config/quantum.json`. The script checks chain health before funding/broadcast and resumes its deployment journal. Until deployed, the app explains that the verifier and factory must be deployed first. Open `http://localhost:3000/app`, create a quantum wallet, deploy it, claim test tokens, and review a swap or transfer.

This is an experimental test-asset prototype. Upstream ETHFalcon explicitly states that it is unaudited. This adds post-quantum wallet authorization; it does not make the entire Ethereum/devnet stack quantum-secure.

## Verification record

The compiled browser signer was checked against the pinned official Solidity verifier. All 39 Solidity tests passed, including 10 quantum-wallet tests for Falcon-only token/native transfers, replay, modified calls, domain/expiry checks, missing signatures and batch rollback. All 62 JavaScript tests and the production web build passed.

The real Chrome virtual authenticator test reproduced the same PRF-derived owner after reload, produced fresh signatures, rejected unsupported PRF and wrong-owner metadata, and persisted only public metadata. Its [public signature fixture](../tests/fixtures/ethfalcon-browser.json) is also verified by the Solidity test suite.

Deployment addresses and chain identity are recorded in `config/quantum.json`. Generated execution reports are kept outside git under `.framepay/`.

The full app browser check on FramePay devnet confirmed six real sponsored frame transactions: wallet deployment, token claims, a swap, a transfer, recurring-position creation and cancellation. The last two used a replacement relay key for the same Falcon wallet. Public metadata export/import restored the wallet, missing user verification was rejected before broadcast, and the run reported no browser runtime errors.

With the app running, reproduce this using `npm run passkey:demo`. Set `FRAMEPAY_APP_URL` to test a different app origin. This uses a disposable Chrome virtual authenticator; its test wallet cannot be controlled after the browser closes. Reports and screenshots remain in ignored `.framepay/passkey-browser/`.
