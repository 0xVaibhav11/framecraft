import { readdir, readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { check } from '@framepay/privacy';
import { root, local, sha256, sourcePins } from './files.ts';

export async function sourceTree(directory: string): Promise<string> {
  const files: [string, string][] = [];
  async function walk(at: string, prefix = ''): Promise<void> {
    for (const entry of (await readdir(at, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.isDirectory()) await walk(join(at, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.sol')) files.push([prefix + entry.name, sha256(await readFile(join(at, entry.name)))]);
    }
  }
  await walk(directory);
  return sha256(JSON.stringify(files));
}
export async function checkSources(): Promise<void> {
  const pins = await sourcePins();
  // Same pinned revision as FramePay's public SwapVM integration.
  const publicPins = JSON.parse(await readFile(resolve(root, 'config/aqua-sources.json'), 'utf8')) as { sources: { name: string; solidityTreeSha256: string }[] };
  check(await sourceTree(resolve(root, 'vendor/swap-vm/contracts')) === publicPins.sources.find((p) => p.name === '@1inch/swap-vm')!.solidityTreeSha256, 'SwapVM source fingerprint differs');
  for (const dependency of pins.dependencies) {
    const directory = resolve(root, 'vendor/private-deps', dependency.name);
    const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')) as { version: string };
    check(pkg.version === dependency.version, `Dependency version differs: ${dependency.name}`);
    check(await sourceTree(directory) === dependency.treeSha256, `Dependency source differs: ${dependency.name}`);
  }
  for (const [name, expected] of Object.entries(pins.railgun)) {
    check(sha256(await readFile(resolve(root, 'config/private/railgun', name))) === expected, `RAILGUN artifact differs: ${name}`);
  }
}
export async function setupSources(): Promise<void> {
  const pins = await sourcePins();
  await mkdir(local, { recursive: true });
  async function extract(url: string, expected: string, destination: string): Promise<void> {
    try { await readdir(destination); return; } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const temporary = await mkdtemp(resolve(local, 'source-'));
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      check(response.ok, 'Source download failed');
      const bytes = Buffer.from(await response.arrayBuffer());
      check(sha256(bytes) === expected, 'Source archive fingerprint differs');
      const archive = resolve(temporary, 'source.tgz');
      await writeFile(archive, bytes);
      await mkdir(destination, { recursive: true });
      execFileSync('tar', ['-xzf', archive, '-C', destination, '--strip-components=1']);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  await extract(`https://codeload.github.com/1inch/swap-vm/tar.gz/${pins.swapvm.revision}`, pins.swapvm.archiveSha256, resolve(root, 'vendor/swap-vm'));
  for (const dep of pins.dependencies) await extract(dep.url, dep.sha256, resolve(root, 'vendor/private-deps', dep.name));
  await checkSources();
}
