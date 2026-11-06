# Private integration source inputs

`railgun/` contains only the public original creation artifacts and published verification-key table supplied with `private-poc-bundle`. No keys, mnemonics, deployment journals, or historical POC run reports were copied.

`sources.json` pins every copied file, the SwapVM archive/revision, Solidity dependency archives and source trees, and the RAILGUN 1x2 proving files. The TypeScript setup verifies these fingerprints; the Foundry real-proof test deploys the original creation bytes and changes only the proxy owner constructor argument and the two Poseidon library references, exactly as the bundle does.

The proving artifact CID and wasm/zkey hashes originate from the bundle's RAILGUN wallet artifact-v2 manifest. The vkey JSON checksum pins the bundled public file. RAILGUN's deployed verifier remains authoritative.

Upstream code and bytecode retain their original licenses. In particular, the restricted SwapVM extension imports code under `LicenseRef-Degensoft-SwapVM-1.1`; the downloaded SwapVM source includes its license text. This directory is deployment input, not a claim to have independently audited RAILGUN or SwapVM.
