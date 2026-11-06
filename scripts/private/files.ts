import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const local = resolve(root, '.framepay/private');
export const runtime = resolve(local, 'runtime');
export const json = (value: unknown): string => JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
export const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
export const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
export async function readOptional<T>(file: string): Promise<T | undefined> {
  try { return await readJson<T>(file); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
export async function saveJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, json(value), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}
export interface SourcePins {
  swapvm: { revision: string; archiveSha256: string };
  dependencies: { name: string; version: string; url: string; sha256: string; treeSha256?: string }[];
  railgun: Record<string, string>;
  circuit: { cid: string; hashes: Record<'wasm' | 'zkey' | 'vkey.json', string> };
}
export const sourcePins = () => readJson<SourcePins>(resolve(root, 'config/private/sources.json'));
