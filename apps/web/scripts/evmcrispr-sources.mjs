// Vite aliases that resolve every @evmcrispr/* import straight to the
// TypeScript sources of an EVMcrispr checkout (no build step in EVMcrispr).
// Adapted from the Assertions website's setup.
//
// By default the checkout is apps/web/.evmcrispr/, a clone of the EVMcrispr
// repo at the commit pinned in apps/web/package.json's "evmcrispr" field,
// created by scripts/vendor-evmcrispr.mjs (run before dev, build and check).
// To develop against your own checkout instead, point EVMCRISPR_SRC at it:
//
//   EVMCRISPR_SRC=~/Projects/EVMcrispr bun run web:dev
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exact = (specifier) => new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`);

export const evmcrisprSrc = process.env.EVMCRISPR_SRC
  ? path.resolve(process.env.EVMCRISPR_SRC.replace(/^~/, process.env.HOME ?? "~"))
  : path.join(webDir, ".evmcrispr");

if (!existsSync(evmcrisprSrc))
  throw new Error(
    `EVMcrispr checkout not found at "${evmcrisprSrc}": run \`bun run prepare:evmcrispr\` in apps/web (dev, build and typecheck do this), or point EVMCRISPR_SRC at a local EVMcrispr repo.`
  );

/** @type {import('vite').Alias[]} */
const alias = [];
/** @type {string[]} */
const ids = [];
for (const group of ["packages", "modules"]) {
  const groupDir = path.join(evmcrisprSrc, group);
  if (!existsSync(groupDir)) continue;
  for (const dir of readdirSync(groupDir).sort()) {
    const pkgPath = path.join(groupDir, dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (!pkg.name?.startsWith("@evmcrispr/")) continue;
    // Exact-match regexes: a bare package-name alias would also prefix-match
    // sub-path imports (e.g. @evmcrispr/editor/style.css) and mangle them.
    for (const [key, value] of Object.entries(pkg.exports ?? {})) {
      if (key === ".") continue;
      // Sub-paths with a source (`bun`) entry, or a plain file such as
      // ./style.css (built by the vendor script) and the grammars.
      const target = typeof value === "string" ? value : value?.bun;
      if (target) alias.push({ find: exact(`${pkg.name}${key.slice(1)}`), replacement: path.join(groupDir, dir, target) });
    }
    alias.push({ find: exact(pkg.name), replacement: path.join(groupDir, dir, pkg.exports?.["."]?.bun ?? "src/index.ts") });
    ids.push(pkg.name);
  }
}
if (!ids.length)
  throw new Error(`"${evmcrisprSrc}" contains no @evmcrispr/* packages: point EVMCRISPR_SRC at the EVMcrispr repo root.`);

/** The checkout's monaco-editor package (the version the editor pins). */
export function monacoDir() {
  const editor = createRequire(path.join(evmcrisprSrc, "packages/editor/package.json"));
  // The exports map hides package.json; "." (require) is min/vs/index.js.
  return path.resolve(path.dirname(editor.resolve("monaco-editor")), "../..");
}

// The editor loads Monaco's AMD build from /vs (scripts/copy-monaco.mjs); its
// only runtime import of the ESM package is the completion-kind enum. Point
// that at Monaco's dependency-free enums instead of bundling a second Monaco.
alias.push({ find: exact("monaco-editor"), replacement: path.join(webDir, "src/lib/monaco-languages.ts") });
alias.push({
  find: exact("@framepay/monaco-enums"),
  replacement: path.join(monacoDir(), "esm/vs/editor/common/standalone/standaloneEnums.js"),
});

// Deps imported only from the excluded @evmcrispr sources live in the
// checkout's own node_modules, so the dev server's startup scan cannot find
// them and would re-optimize (and force-reload the page) when the editor
// first loads them. Alias each to its vendored location so it can be
// pre-bundled eagerly (optimizeDeps.include in astro.config.mjs).
/** @type {string[]} */
const vendoredDepIds = [];
{
  /** Each vendored package and the deps only it imports, as `astro dev
   *  logs` reported them ("dependencies optimized" after a page reload). */
  const importers = [
    ["packages/editor", [
      "@monaco-editor/react", "@radix-ui/react-popover", "@heroicons/react/24/outline",
      "@heroicons/react/24/solid", "class-variance-authority", "clsx", "tailwind-merge",
      "react-markdown", "remark-gfm", "shiki/core", "shiki/engine/oniguruma", "shiki/wasm",
      "shiki/langs/json.mjs", "shiki/langs/solidity.mjs",
    ]],
    ["packages/core", ["arcsecond"]],
    ["packages/sdk", ["abitype", "jsymbol"]],
  ];
  for (const [pkg, depIds] of importers) {
    const req = createRequire(path.join(evmcrisprSrc, pkg, "package.json"));
    for (const id of depIds) {
      const bare = id.split("/").length === (id.startsWith("@") ? 2 : 1);
      let replacement;
      try {
        replacement = req.resolve(id);
      } catch {
        continue; // not a dependency at this pin
      }
      if (bare) {
        // The package root (its package.json names it), so Vite's own
        // module/exports resolution still picks the right build.
        let dir = path.dirname(replacement);
        while (!(existsSync(path.join(dir, "package.json")) && JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")).name === id))
          dir = path.dirname(dir);
        replacement = dir;
      }
      alias.push({ find: exact(id), replacement });
      vendoredDepIds.push(id);
    }
  }
  // Ours, imported only from those sources or behind an alias.
  vendoredDepIds.push("viem/chains", "viem/ens", "@framepay/monaco-enums");
}

console.log(`[evmcrispr] using sources from ${evmcrisprSrc} (${ids.length} packages)`);

export const local = { alias, ids };
export { vendoredDepIds };
