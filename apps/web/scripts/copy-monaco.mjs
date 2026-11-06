// @evmcrispr/editor loads Monaco's AMD build from `/vs` on the site's own
// origin (no third-party CDN). Sync the vendored monaco-editor's min/vs into
// public/vs so both `next dev` and the built site serve it.
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { monacoDir } from "./evmcrispr-sources.mjs";

const source = path.join(monacoDir(), "min/vs");
const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/vs");

if (existsSync(target)) rmSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`[monaco] copied ${source} -> public/vs`);
