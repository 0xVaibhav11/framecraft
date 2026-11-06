// @ts-check
import path from "node:path";
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import { evmcrisprSrc, local, vendoredDepIds } from "./scripts/evmcrispr-sources.mjs";

// https://astro.build/config
export default defineConfig({
  integrations: [react()],
  vite: {
    // The /editor page embeds EVMcrispr's editor from its TypeScript sources
    // (scripts/vendor-evmcrispr.mjs, scripts/evmcrispr-sources.mjs).
    resolve: {
      alias: local.alias,
      // The vendored sources would otherwise pick up the checkout's own
      // copies: two Reacts break hooks, two viems split their types.
      dedupe: ["react", "react-dom", "viem"],
    },
    server: {
      // The sources may live outside the project root (EVMCRISPR_SRC).
      fs: { allow: [path.resolve("."), path.resolve("../.."), evmcrisprSrc] },
      // The checkout carries turbo's cache (tens of thousands of files):
      // watching it exhausts inotify watchers.
      watch: { ignored: ["**/.turbo/**"] },
    },
    optimizeDeps: {
      exclude: local.ids,
      include: vendoredDepIds,
    },
  },
});
