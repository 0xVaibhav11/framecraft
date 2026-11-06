import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Abi, Hex } from 'viem';
import { check } from '@framepay/privacy';
import { root } from './files.ts';
import { checkSources } from './sources.ts';

export interface Artifact { abi: Abi; bytecode: Hex; runtimeBytes: number }
export interface Artifacts { PrivateSwapVM: Artifact; TestToken: Artifact; Aqua: Artifact }
export async function buildContracts(): Promise<Artifacts> {
  await checkSources();
  // Foundry owns compilation; an optional native compiler path helps offline environments.
  const compiler = process.env.FRAMEPAY_PRIVATE_SOLC;
  execFileSync('forge', ['build', '--root', resolve(root, 'contracts/private'), '--skip', 'test', ...(compiler ? ['--use', compiler] : [])], { stdio: 'inherit' });
  const load = async (source: string, name: string): Promise<Artifact> => {
    const artifact = JSON.parse(await readFile(resolve(root, `contracts/private/out/${source}.sol/${name}.json`), 'utf8')) as {
      abi: Abi; bytecode: { object: Hex }; deployedBytecode: { object: Hex };
    };
    const runtimeBytes = (artifact.deployedBytecode.object.length - 2) / 2;
    check(runtimeBytes <= 24_576, `${name} exceeds EIP-170`);
    return { abi: artifact.abi, bytecode: artifact.bytecode.object, runtimeBytes };
  };
  return { PrivateSwapVM: await load('FramePayPrivateSwapVM', 'FramePayPrivateSwapVM'),
    TestToken: await load('PrivateTestToken', 'PrivateTestToken'), Aqua: await load('Aqua', 'Aqua') };
}
