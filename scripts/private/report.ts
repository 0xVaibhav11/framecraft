import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { check } from '@framepay/privacy';
import { local, readJson } from './files.ts';
import type { RunReport } from './demo.ts';
export async function writeReport(): Promise<void> {
  const report = await readJson<RunReport>(resolve(local, 'reports/latest.json'));
  check(report.status === 'passed', 'Only a completed passing run can produce a verification report');
  const rows = report.flows.map((flow) => `| ${flow.label} | \`${flow.hash}\` | ${BigInt(flow.receipt.gasUsed)} | ${flow.receipt.frameReceipts!.map((frame) => frame.status === '0x1' ? 'success' : 'reverted').join(' / ')} |`).join('\n');
  await writeFile(resolve(local, 'reports/VERIFICATION.md'), `# FramePay private-flow verification\n\nRun: ${report.runId}. Result: PASS. Chain: 1337.\n\nGateway: ${report.rpcUrl ?? "not recorded"}. Genesis: ${report.infrastructure.genesis}.\n\nEvery row is a native type-0x06 frame transaction with sidecar admission evidence in [the run record](${report.runId}.json).\n\n| Flow | Transaction | Gas | VERIFY / SENDER |\n| --- | --- | ---: | --- |\n${rows}\n\n${report.negativeChecks.map((check) => `- ${check.label}: ${check.result}`).join('\n')}\n\nMaker-owned quoting inventory, not pooled LP shares. Aqua is unchanged and outside private settlement. The separate public EOA submitter pays gas. Deposits and withdrawals are public. Real Groth16 proofs do not establish production anonymity, post-quantum privacy, or a security audit.\n`);
}
