// Stands in for `monaco-editor` in the vendored EVMcrispr editor (see
// scripts/evmcrispr-sources.mjs). Monaco itself is loaded from /vs; the
// editor imports the package at runtime only for this enum.
// @ts-expect-error resolved by a webpack alias to Monaco's standaloneEnums.js
import { CompletionItemKind } from "@framepay/monaco-enums";

export const languages = { CompletionItemKind };
