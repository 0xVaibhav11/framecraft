# Agent handoff: use frame transactions locally

You are working in the `mempool-workshop` repository. Read `AGENTS.md` and the
work-in-progress notice in `README.md` before changing or running anything.
The local infrastructure setup is documented in `LOCAL_DEVNET.md`.

## What is running

This is an experimental EIP-8141 devnet, not a normal Ethereum node or Anvil.
EIP-8141 transactions contain ordered frames for validation and execution,
with separate execution and state gas limits. The codec uses transaction type
`0x06` and the `ethrex-eip8141-tracer` profile.

| Item | Local value |
| --- | --- |
| Gateway JSON-RPC | `http://localhost:14337/rpc` |
| Explorer | `http://localhost:5173/` |
| Chain ID | `1337` (`0x539`) |
| Staking registry | `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` |
| Entry-point sentinel, not a deployed ERC-4337 EntryPoint | `0x00000000000000000000000000000000000000aa` |
| Workshop configuration | `workshop.config.json5` |
| Participant key and progress | `.workshop-state.json` — never print or commit its key |
| Sidecar checkout | `mempool-workshop-sidecar/` |

Request path: your script → gateway sidecar → P2P gossip → miner sidecar → ethrex.
The gateway also forwards chain reads and raw transactions to ethrex. Send all
application requests to the gateway; do not connect directly to the miner or ethrex.
Lighthouse provides consensus and block production.

The **canonical mempool** is EIP-8141's public mempool, validated by ethrex.
The **standard alt-mempool** is the sidecar's rule set. This fork follows
`forshtat/ERCs` PR #6 and is not exactly the later ERC-8421 specification.

## Start and send a transaction

Run commands from the workshop root. Requirements: Docker Desktop running,
Node 20.12+, Yarn 1, and Bun for the explorer build.

```sh
node mempool-workshop-sidecar/deploy/local/start.mjs
```

This preserves existing local data. On a newly initialized chain, frame
transactions become available about 11 minutes after initialization, when
Hegota activates. A working `eth_chainId` response alone does not prove readiness.

If dependencies are missing, run `yarn install --frozen-lockfile` in the workshop
and `bun install --frozen-lockfile --linker hoisted` in the sidecar checkout.

For a new participant/workshop session:

```sh
yarn step_1_check
yarn step_2_tx_first
```

**Do not rerun step 1 merely to check connectivity:** it resets recorded addresses
and completed steps, retaining the participant key. It requests faucet funds if
needed. Steps 1 and 2 passed during this local setup: the faucet supplied 1 ETH
and a transaction with two successful frames was mined in block 67.

To resume, inspect only safe progress fields:

```sh
node -e 'const s=require("./.workshop-state.json"); console.log({account:s.account,completedSteps:s.completedSteps,lastTxHash:s.lastTxHash})'
```

For a read-only connectivity check:

```sh
curl -s http://localhost:14337/rpc \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

## Minimal TypeScript example

The existing `src/steps/step_2_tx_first.ts` is the simplest reference.
For your own script, save this as `src/local-frame-demo.ts` and run
`yarn -s tsx src/local-frame-demo.ts` after step 1 has initialized the participant.
This sends real transactions on the throwaway local chain.

```ts
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "./lib/config.js";
import { requireState, writeState } from "./lib/state.js";
import { buildSelfRelayTx, signFrameTx, txHash } from "./lib/frameTx/build.js";
import { accountNonce, sendFrameTx, waitForReceipt } from "./lib/frameTx/send.js";

const cfg = loadConfig();
const key = requireState("participantKey", "step_1_check");
const sender = privateKeyToAccount(key).address;

const unsigned = buildSelfRelayTx({
  from: sender,
  to: cfg.recipient,
  value: cfg.transferWei,
  nonce: await accountNonce(sender),
  chainId: cfg.chainId,
  maxFeePerGas: cfg.maxFeePerGasWei,
});
const signed = await signFrameTx(unsigned, key);
console.log("txHash:", txHash(signed)); // Keep this even if admission fails.
const hash = await sendFrameTx(signed);
writeState({ lastTxHash: hash });
const receipt = await waitForReceipt(hash);
console.log("mined:", Number(receipt.blockNumber), "frames:", receipt.frameReceipts?.length);
```

This builds a `VERIFY` frame approving execution and payment, followed by a
`SENDER` frame transferring value. The EOA signs and pays. `waitForReceipt`
checks the transaction status and each returned frame's status.

For a contract call, encode calldata with viem's `encodeFunctionData`, set the
execution frame's target/data/value, and size its execution/state gas before
signing. `buildStakeTx` in `src/lib/frameTx/build.ts` is a concrete contract-call
example. Any change to the signed envelope requires signing again.

Use the repository helpers and `@forshtat/hegota-support`; do not hand-roll RLP,
signing, or RPC conversion, and do not import the sidecar's built `packages/*/lib`.

## Submission and funding APIs

| Task | Helper or RPC through the gateway |
| --- | --- |
| Submit to the standard alt-mempool | `sendFrameTx(tx)` → `eth_sendFrameTransaction([toWire(tx)])` |
| Submit to the canonical mempool | `sendRawFrameTx(tx)` → `eth_sendRawTransaction([encodeRawFrameTx(tx)])` |
| Read account nonce | `accountNonce(address)` → `eth_getTransactionCount` |
| Wait for inclusion and check frames | `waitForReceipt(hash)` → `eth_getTransactionReceipt` |
| Fund a fresh EOA | `fundFromFaucet(address)` in `src/lib/chain.ts` |
| Faucet RPC | `skandha_explorer_faucet`, params `[address]` |

`toWire` comes from `@forshtat/hegota-support/rpc`, re-exported by the workshop
builder. Do not JSON-serialize the internal transaction's bigint fields directly.
The faucet sends 1 ETH and permits one request per address per hour.

## Other useful examples

| Goal | Commands, in dependency order |
| --- | --- |
| Paymaster pays for a sender | `yarn step_3_tx_paymaster` (needs step 1) |
| Deploy and use a contract wallet | `yarn step_4_wallet_deploy`, then `yarn step_5_tx_wallet` |
| Compare admission before/after staking | `yarn step_6_tx_violating_canonical`, `yarn step_7_stake`, `yarn step_8_tx_violating_alt` |
| Independent nonce keys | `yarn step_12_tx_keyed_nonces` (needs step 4) |
| Recent-root references | `yarn step_13_tx_recent_roots` (needs step 4) |

The corresponding files in `src/steps/` show complete implementations. Contract
sources are in `contracts/src/`; compiled artifacts are committed, so Foundry is
unnecessary unless editing Solidity. The optional `contracts/fork/` variant is
experimental and must not replace the workshop contracts.

## Rules and troubleshooting

- Workshop config comes only from `workshop.config.json5`; all keys are required,
  unknown keys fail, and workshop scripts do not use environment variables.
  The infrastructure's generated config/env files are separate.
- Read nonces from the chain. A contract starts at nonce 1; these wallets create
  seven helpers and normally start at 8. Run ordinary-nonce sends sequentially,
  waiting for inclusion before building the next transaction.
- Fund frame-aware contracts through their creation `value`. A plain ETH transfer
  invokes their validation code outside a frame and can fail.
- A transfer to a new account needs nonzero state gas. Keep the helpers' defaults
  for the basic example.
- After a rejection, run `yarn step_11_debug <txHash>`. It returns the admission
  checks, lifecycle and status. Do not guess a rule from a generic error.
- `STEP_ORDER`: run the prerequisites in the error hint. `STATE_STALE`: redeploy
  the affected step with `--fresh`. `TX_NOT_MINED`: check blocks and gateway peers
  in the explorer. A pre-Hegota error means the fork has not activated yet.
- Steps 6 and 10 expect rejection; exit 0 means their expected rejection occurred.
  For machine output use `yarn -s <step> --json`.
- Never call mutating `debug_*` methods directly. Reputation changes are allowed
  only via `step_9_reputation_burn` / `reset_reputation` for the participant's own
  wallet. Step 9 is a declared shortcut that writes reputation counters.
- Do not search for or use the public devnet's genesis key. Use the local faucet.

Logs and stop commands are in `LOCAL_DEVNET.md`. The detailed RPC and explorer
references are `mempool-workshop-sidecar/deploy/devnet/devnet-readme.md` and
`mempool-workshop-sidecar/docs/sidecar_explorer.md`; substitute the local gateway
for public endpoints in those documents.
