// Vendors the EVMcrispr monorepo into apps/web/.evmcrispr/ at the commit
// pinned in apps/web/package.json's "evmcrispr" field, installs its
// dependencies with bun (it is a bun workspace), generates its sources and
// builds the editor's stylesheet. next.config.mjs aliases every @evmcrispr/*
// import to this checkout's TypeScript sources (see evmcrispr-sources.mjs).
//
// The `frame` module (EIP-8141 frame transactions) only exists on EVMcrispr's
// `next` branch, so there is no npm release to install instead.
//
// To develop against your own checkout, set EVMCRISPR_SRC to its repo root
// (with dependencies installed, codegen run and packages/editor/dist/style.css
// built); this script then does nothing.
//
// To bump the pin: update "evmcrispr.commit" in apps/web/package.json, e.g. to
// the output of `git ls-remote https://github.com/EVMcrispr/evmcrispr.git next`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { evmcrispr } = JSON.parse(
  readFileSync(path.join(webDir, "package.json"), "utf-8")
);
const { repo, commit } = evmcrispr;
const dir = path.join(webDir, ".evmcrispr");
const readyFile = path.join(dir, "node_modules", ".framepay-ready-commit");

if (process.env.EVMCRISPR_SRC) {
  console.log(
    `[evmcrispr] EVMCRISPR_SRC is set; using ${process.env.EVMCRISPR_SRC} instead of the vendored clone`
  );
  process.exit(0);
}

const git = (...args) =>
  execFileSync("git", ["-C", dir, ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  })
    .toString()
    .trim();

let atPin = false;
if (existsSync(path.join(dir, ".git"))) {
  try {
    atPin = git("rev-parse", "HEAD") === commit;
  } catch {
    /* corrupt checkout: refetch below */
  }
}

if (!atPin) {
  if (existsSync(path.join(dir, ".git")) && git("status", "--porcelain"))
    throw new Error(
      "The vendored EVMcrispr checkout has local changes. Commit or preserve them before updating the pin, or use EVMCRISPR_SRC."
    );
  if (!existsSync(path.join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    git("init", "-q");
    git("remote", "add", "origin", repo);
  }
  git("remote", "set-url", "origin", repo);
  console.log(`[evmcrispr] fetching ${repo} @ ${commit.slice(0, 10)}…`);
  git("fetch", "-q", "--depth", "1", "origin", commit);
  git("checkout", "-q", "--detach", commit);
}

if (!existsSync(readyFile) || readFileSync(readyFile, "utf-8").trim() !== commit) {
  console.log("[evmcrispr] installing dependencies (bun install)…");
  execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: dir, stdio: "inherit" });
  // The packages' src/_generated.ts files are codegen output, not committed.
  console.log("[evmcrispr] generating sources (turbo run codegen)…");
  execFileSync(path.join(dir, "node_modules/.bin/turbo"), ["run", "codegen"], {
    cwd: dir,
    stdio: "inherit",
  });
  // @evmcrispr/editor/style.css is a build output (dist/style.css).
  console.log("[evmcrispr] building the editor stylesheet…");
  execFileSync("bun", ["run", "--bun", "scripts/build-css.ts"], {
    cwd: path.join(dir, "packages/editor"),
    stdio: "inherit",
  });
  writeFileSync(readyFile, `${commit}\n`);
}

console.log(`[evmcrispr] ready: .evmcrispr @ ${commit.slice(0, 10)}`);
