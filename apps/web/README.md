# FramePay web

Static Astro site with strict TypeScript configuration and the Framecraft EVML
editor. The Next.js proof of concept lives in `../poc`.

For Vercel, import the repository with **Root Directory `.`** and **Node.js 24.x**.
The root `vercel.json` installs dependencies with pinned Bun, builds this app,
and publishes `apps/web/dist`. No environment variables, server adapter,
Emscripten, or Foundry are required. See the [deployment guide](../../docs/vercel.md)
for exact settings, build prerequisites, and passkey-origin behavior.

Run these commands from the repository root:

| Command | Purpose |
| --- | --- |
| `bun install` | Install workspace dependencies |
| `bun run web:dev` | Start Astro at `http://localhost:4321` |
| `bun run web:typecheck` | Check Astro and TypeScript files |
| `bun run web:build` | Type-check and build to `apps/web/dist` |
| `bun run web:preview` | Preview the production build |

Add routes in `src/pages` and static assets in `public`. TypeScript extends
`astro/tsconfigs/strict`. This workspace uses TypeScript 6 for compatibility
with `@astrojs/check`; the other workspaces keep their existing compiler.

`@emnapi/runtime` is pinned to 1.11.3 to match the checker’s `@astrojs/astro2tsx`
compiler. This prevents Bun from pairing its 1.x core with an incompatible
2.x runtime peer.

## Private EVML scripts

Open `/editor`, select **Framecraft devnet**, then create/import your private
wallet, deploy it and use **Get FPA + FPB**. Wallet metadata is public; the
original PRF-capable passkey and its exact origin are required to spend. The
editor uses `frameNetworks.devnet.rpcUrl` (currently
`https://psi-essential-rebate-wrist.trycloudflare.com/rpc`) and verifies the
recorded genesis and deployment code. A POC wallet can be restored only when
served at its original origin; otherwise create a separate wallet here.

Private spending commands can be composed with public calls inside `frame:tx`.
The entire block is prepared, signed and sent **once** through
`eth_sendFrameTransaction` to your server's alt mempool. `--mempool alt` is the
default; `canonical` is rejected by this host.

```evml
load frame [tx]
load privacy [@token]
set $paymaster 0xF13aB1CE9463FAaF2d01b25998F83ecF297Ffc22

# Shielding creates notes. Wait for this transaction before spending them.
tx --paymaster $paymaster (
  batch (
    privacy:shield @token("FPA") "10" --wallet savings
    privacy:shield @token("FPB") "10" --wallet trading
  )
)

# These proofs use already-confirmed inputs, one per private operation.
tx --paymaster $paymaster (
  batch (
    privacy:transfer @token("FPA") "1" trading --wallet savings
    privacy:unshield @token("FPB") "0.5" @me --wallet trading
  )
)
privacy:scan
```

`@me` above is the public relay account: the unshielded tokens go there. Ordinary
`exec` calls can appear before, between and after private calls, including in the same
`batch`. They keep their original targets, calldata and relay-sender semantics.
Private calls execute from your passkey wallet. `--paymaster` is optional: without
it the relay account needs enough ETH to pay the whole envelope's gas.

For swaps, choose a liquidity pocket, fund it with both assets and run `privacy:quote`.
Use its exact output in the swap block:

```evml
load frame
load privacy [@token]
# Assumes liquidity has both assets and trading has a confirmed FPB note.
privacy:scan --wallets "trading,liquidity"
privacy:quote "0.1" --inventory liquidity
# Copy the quote output into --expect, then run this block separately:
frame:tx --paymaster 0xF13aB1CE9463FAaF2d01b25998F83ecF297Ffc22 (
  privacy:swap "0.1" --expect "0.095238095238095238" --wallet trading --inventory liquidity
)
```

The number above is illustrative: a changed quote fails before submission.
Amounts are quoted human-readable decimals with at most 18 decimal places,
greater than zero and at most 10,000.

`load privacy [@token]` imports the deployment-aware token helper, so
`@token("FPA")` and `@token("FPB")` resolve to the configured ERC-20 addresses
without relying on a public token list. `@privacy:token(...)` is the qualified
form. Plain `FPA`/`FPB`, raw configured addresses, the native
`@std:token("0x…")` helper, and legacy `A`/`B` aliases are also accepted by private
commands. Other token addresses are rejected; the worker currently supports only
these two assets. Use `@std:token(...)` for EVML's usual token-list resolution in
public calls.

EVML evaluates helpers before calling the private command. `@me` retains its
standard meaning: the editor's connected public relay address. It works as an
unshield recipient, but cannot replace `--wallet savings` or a private recipient.

Pocket names are dynamic: `--wallet savings`, `--wallet payroll` and
`--inventory liquidity` select different private keys derived from **your own
passkey**, wallet address, chain domain and exact pocket name. They do not identify
other people. Names start with a lowercase letter and use up to 32 lowercase
letters, digits, underscores or hyphens; object prototype names are reserved.
Up to 64 pockets can be tracked per wallet. `maker`, `taker` and `inventory` remain
legacy names with unchanged addresses, so existing notes remain recoverable.
For compatibility, omitted `--wallet` still defaults to `maker` (`taker` for swaps),
and omitted `--inventory` defaults to `inventory`.

Every operation scans the known pockets plus any new names it references. New
names are saved in public wallet metadata before an operation can fund them;
export updated metadata after adding pockets. Restore missing names explicitly
with `privacy:scan --wallets "savings,trading,liquidity"`. Changing a name derives a
different pocket; it does not rename or migrate its funds. Scanning a new name
requires another passkey approval even if other balances are already unlocked.

To pay a friend, use their full RAILGUN `0zk…` receiving address for this devnet
pool. Variables can name as many recipients as the frame limit allows:

```evml
load frame
load privacy [@token]
# Replace these placeholders with your friends' full private receiving addresses.
set $alice "0zk…alice-full-address…"
set $bob "0zk…bob-full-address…"
set $charlie "0zk…charlie-full-address…"
frame:tx --paymaster 0xF13aB1CE9463FAaF2d01b25998F83ecF297Ffc22 (
  batch (
    privacy:transfer @token("FPA") "1" $alice --wallet savings
    privacy:transfer @token("FPA") "1" $bob --wallet savings
    privacy:transfer @token("FPA") "1" $charlie --wallet savings
  )
)
```

That example needs **three distinct confirmed input notes** in `savings`.
Recipients do not approve receipt; only their own wallet keys can spend their
received notes. The worker decodes and checks each private address before proving.
Using the bare name `alice` instead of `$alice` would select a pocket under your
own passkey.

The deployed swap adapter settles **two legs per swap**. Both are currently proved
by the local worker, so both selected swap pockets must belong to your passkey.
Multiple transfers/swaps can be composed in one frame transaction, but an
independent-party swap needs a separate exchange of each party's authorized proof.
Dynamic names do not supply someone else's signing authority, and an N-party
atomic swap is not implemented by the current two-leg adapter.

| Command | Behavior |
| --- | --- |
| `privacy:scan --wallets "savings,trading,liquidity"` | Unlock/refresh known and selected pocket balances, single-note limits and private addresses |
| `privacy:shield @token("FPA") "10" --wallet savings` | Approve, shield to the pocket, and clear approval in one wallet batch |
| `privacy:transfer @token("FPA") "1" trading --wallet savings` | Transfer between owned pockets, or replace `trading` with a quoted friend's `0zk…` address |
| `privacy:add-inventory @token("FPA") "2" --wallet savings --inventory liquidity` | Move savings → liquidity |
| `privacy:remove-inventory @token("FPA") "1" --wallet savings --inventory liquidity` | Move liquidity → savings |
| `privacy:quote "0.1" --inventory liquidity` | Refresh an unlocked session and quote against the selected liquidity pocket |
| `privacy:swap "0.1" --expect "…" --wallet trading --inventory liquidity` | Settle both private swap legs between the selected owned pockets |
| `privacy:unshield @token("FPA") "1" "0x…" --wallet savings` | Unshield to the specified nonzero public recipient |
| `privacy:lock` | Clear the viewing session |

Spending commands use the existing `packages/privacy` proof code in an isolated
browser worker. Keys never enter the script, logs, local storage or RPC requests.
Inside `frame:tx`, interpretation produces compiler descriptors only. At execution,
one passkey approval binds the complete frame plan; the worker prepares every
private proof and signs consecutive wallet nonces. Each descriptor becomes a
SENDER frame calling `wallet.execute`, retaining frame order, gas limits and
atomic flags. Only the fully materialized envelope is signed by the relay and
submitted. Compiler descriptors are rejected by the normal frame serializer.

The worker reserves each input note after proving it. **Every input must already
be confirmed and may be spent only once in a block.** Change, received transfers
and newly shielded notes cannot be spent until the enclosing transaction confirms.
Multiple operations can use distinct existing notes. All swap quotes in a block
use the initial inventory snapshot, with exact outputs checked before signing;
notes reserved by an earlier operation are unavailable to later proofs. Proof or
wallet authorization failure prevents the entire envelope from being submitted.

Use `batch` **inside** `frame:tx` when all grouped frames must succeed or revert
together. Bare body frames keep EIP-8141's independent frame execution semantics;
if an earlier private wallet frame fails, later private frames with consecutive
nonces may also fail. Each individual wallet call remains atomic. A script with
multiple `frame:tx` blocks submits them sequentially; it is not globally atomic.

`privacy:scan`, `privacy:quote` and `privacy:lock` remain outside transaction blocks.
Standalone spending commands still work and each sends its own sponsored envelope.
Scan access is view-only and expires after five minutes. Shielding/unshielding
deduct the existing 0.25% pool fee; each payment uses one input note. Swaps exchange
FPB for FPA between pockets you own, matching the POC. The gateway accepts at most
16 frames including verification/payment frames.

A pending/ambiguous submission is saved before broadcast and blocks further
private sends until **Inspect receipt** finds its receipt. Stopping or closing the
page cannot cancel an accepted transaction.

The local module is in `src/lib/privacy/module.ts`; `frame-plan.ts` materializes
private entries without changing public frame order. `runtime.ts` submits the
complete envelope and reuses `scripts/private/browser/session.ts` and its worker,
also used by `apps/poc`.

### Browser assets and checks

The dev/build scripts generate the privacy worker and copy verified circuits into
`public/privacy`, and copy the pinned Falcon signer into `public/ethfalcon`.
These generated public directories are ignored by git. The small public signer
artifact is checked in at `packages/sdk/assets/ethfalcon` with its source pins,
SHA-256 manifest, and upstream license. Preparation rejects stale or corrupt
artifacts. A fresh web checkout needs no C compiler; to regenerate the artifact,
run `bun run quantum:bootstrap` and `bun run quantum:build` with Emscripten 3.1.74
(see [the signer instructions](../../packages/sdk/assets/ethfalcon/README.md)).

- `bun run web:test:privacy`: real EVML parsing/execution tests for the local module.
- `bun run private:test`: privacy package and worker types/tests.
- `bun run web:build`: browser assets, typechecking and production build.
