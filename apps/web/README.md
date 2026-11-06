# FramePay web

Minimal Astro site with strict TypeScript configuration. The existing Next.js
proof of concept lives in `../poc`.

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
