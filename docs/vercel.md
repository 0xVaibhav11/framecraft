# Deploy Framecraft to Vercel

The Astro application in `apps/web` deploys as a static site. The repository-root
`vercel.json` selects Astro, pins Bun 1.3.6 for installation and build, and publishes
`apps/web/dist`. It builds the editor and its SDK/privacy dependencies. It does
not build or deploy the Next.js POC, Solidity contracts, or a blockchain node.

## Vercel project settings

Import this Git repository into Vercel and use:

| Setting | Value |
| --- | --- |
| Root Directory | Repository root (`.`), containing `vercel.json` and `bun.lock` |
| Framework Preset | Astro |
| Node.js Version | 24.x |
| Install Command | `HUSKY=0 bunx bun@1.3.6 install --frozen-lockfile` |
| Build Command | `bunx bun@1.3.6 run web:build` |
| Output Directory | `apps/web/dist` |
| Environment variables | None required |

The commands and output directory are already set in `vercel.json`. Keep the
Root Directory at the repository root: the web app imports shared packages,
configuration, and browser-worker source from outside `apps/web`. If this
repository is nested in a larger Git repository, select the `framepay` directory
containing those files instead.

No Vercel adapter or server functions are needed for this static application.
Do not use the root `bun run build` as the deployment command; that also builds
the other application and Foundry workspace.

## What a fresh build prepares

1. Fetches the EVMcrispr revision pinned in `apps/web/package.json`, installs its
   locked dependencies, runs code generation, and prepares its editor styles.
2. Copies Monaco's browser assets into `/vs/`.
3. Builds `@framepay/sdk` and `@framepay/privacy`.
4. Verifies the checked-in public Falcon signer against `config/ethfalcon.json`
   and its SHA-256 manifest, then copies it and the operation worker into
   `/ethfalcon/`.
5. Downloads any missing RAILGUN circuit artifacts from the configured public
   mirrors, verifies their pinned SHA-256 hashes, and bundles the browser privacy
   worker into `/privacy/`.
6. Runs Astro's type checks and produces static HTML, JavaScript, styles, and
   worker assets in `apps/web/dist`.

The initial build needs network access to GitHub, the package registries, and
the circuit mirrors. It does not require Emscripten, Foundry, local runtime keys,
or a sibling workshop checkout. A source or circuit integrity mismatch fails the
build; do not bypass it by editing a digest. Rebuilding the public signer is
documented in [its artifact directory](../packages/sdk/assets/ethfalcon/README.md).

## Verify locally

```sh
nvm use
bun install --frozen-lockfile
bun run web:build
bun run web:preview
```

Open the preview URL printed by Astro and check `/` and `/editor`. The build
must contain `/ethfalcon/falcon.mjs`, `/ethfalcon/worker.mjs`,
`/privacy/worker.mjs`, the verified privacy circuits, and `/vs/loader.js`.
Serve the complete output directory, not just its HTML files.

## Network and wallet behavior

The deployed editor calls the selected gateway directly from the browser using
the endpoints in `packages/sdk/src/networks.ts`. Framecraft devnet is an external
service; Vercel does not host it. That gateway must be reachable over HTTPS and
allow the deployed site's origin through CORS. The Next.js-only
`FRAMEPAY_RPC_URL` setting does not configure this static app.

Use a stable production domain for passkey wallets. A new preview domain or a
switch from localhost creates a different origin, so a wallet created there is
not automatically usable on the production domain. Passkey signing and private
proof generation remain in the browser; the deployment needs no signing key,
treasury key, or secret environment variable.

After deployment, open `/editor`, select Framecraft devnet, and check wallet
creation and the public network connection. Transaction tests additionally need
the configured contracts and funded test faucets/paymaster. See the
[editor guide](../apps/web/README.md#private-evml-scripts) for the full workflow.

References: [Astro on Vercel](https://docs.astro.build/en/guides/deploy/vercel/),
[Vercel project configuration](https://vercel.com/docs/project-configuration/vercel-json),
and [pinning Bun for Vercel builds](https://vercel.com/kb/guide/how-to-pin-a-specific-bun-version-for-vercel-builds).
