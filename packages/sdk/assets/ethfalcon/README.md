# Browser ETHFalcon signer

This directory contains the public compiled signer used by the Framecraft static
web deployment. It contains no credential, seed, or private key. The WebAssembly
is embedded in `falcon.mjs`; `build.json` records its SHA-256 digest, upstream
revision, C source fingerprint, and compiler version. The upstream MIT license
is preserved in `LICENSE.txt`.

The web asset preparation script checks this manifest against
`config/ethfalcon.json` and verifies the module digest before copying it into
the site's generated public directory. The operation worker is copied from
`scripts/quantum/worker.mjs`, so its source remains directly reviewable.

To regenerate the artifact, install and activate Emscripten 3.1.74, then run
from the repository root:

```sh
bun run quantum:bootstrap
FRAMEPAY_EMCC=emcc bun run quantum:build
bun run quantum:browser-check
```

The build checks the upstream source pin and writes both this directory and the
POC's generated signer assets. Review and commit the module, manifest, license,
and any source-pin changes together. Do not hand-edit the compiled module or
update the manifest merely to accept a changed digest.
