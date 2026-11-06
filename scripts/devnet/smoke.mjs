import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineChain, http } from 'viem';
import { createFrameClient, privateKeyToFrameSigner } from '@framepay/sdk';
import {
  root, loadConfig, checkPins, loadCodec, invariant, createRpc, probeGateway,
  buildSmokeTx, getAdmissionEvidence, acquireSubmissionLock, writeEvidence, safeError,
} from './runtime.mjs';

// This is a baseline EOA-authorized frame transfer, not a PQ account or paymaster implementation.
invariant(process.argv.length === 2, 'Usage: npm run devnet:smoke');
const cfg = await loadConfig();
const report = {
  schemaVersion: 1, kind: 'frame-smoke', observedAt: new Date().toISOString(),
  gatewayUrl: cfg.gatewayUrl, chainId: cfg.chainId, profile: cfg.profile,
  status: 'not-submitted', authorization: 'SECP256K1 baseline; not post-quantum',
};
let release;
let rpc;
try {
  report.pins = await checkPins(cfg);
  invariant(report.pins.verified, 'Source pins differ; review config/devnet-lock.json before running.');
  rpc = createRpc(cfg);
  report.gateway = await probeGateway(cfg, rpc);
  const client = createFrameClient({
    chain: defineChain({ id: cfg.chainId, name: 'Local frame devnet', nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.gatewayUrl] } } }),
    transport: http(cfg.gatewayUrl, { retryCount: 0, timeout: cfg.rpcTimeoutMs }), profile: cfg.profile,
  });
  release = await acquireSubmissionLock();
  const codec = await loadCodec(cfg);
  const state = JSON.parse(await readFile(resolve(root, cfg.workshopPath, '.workshop-state.json'), 'utf8'));
  invariant(state.completedSteps?.includes('step_1_check'), 'Existing workshop participant has not completed initialization.');
  invariant(/^0x[0-9a-fA-F]{64}$/.test(state.participantKey), 'Missing or malformed workshop participant key.');
  const account = codec.accounts.privateKeyToAccount(state.participantKey);
  invariant(state.account?.toLowerCase() === account.address.toLowerCase(), 'Workshop participant address/key mismatch.');
  report.sender = account.address;
  report.recipient = cfg.recipient;
  report.valueWei = cfg.transferWei;
  const [latestNonce, pendingNonce, senderBalance, recipientCode, balanceBefore] = await Promise.all([
    rpc('eth_getTransactionCount', [account.address, 'latest']),
    rpc('eth_getTransactionCount', [account.address, 'pending']),
    rpc('eth_getBalance', [account.address, 'latest']),
    rpc('eth_getCode', [cfg.recipient, 'latest']),
    rpc('eth_getBalance', [cfg.recipient, 'latest']),
  ]);
  invariant(BigInt(latestNonce) === BigInt(pendingNonce), 'Participant has pending canonical transactions; wait before using its ordinary nonce.');
  invariant(recipientCode === '0x', 'Smoke recipient must be an EOA.');
  invariant(account.address.toLowerCase() !== cfg.recipient.toLowerCase(), 'Smoke recipient must differ from sender.');
  // Generous preflight funding floor, not a claim about the protocol's exact intrinsic gas formula.
  invariant(BigInt(senderBalance) >= 1_000_000_000_000_000n, 'Participant needs at least 0.001 local ETH; use the workshop faucet.');
  const template = buildSmokeTx(codec, cfg, account.address, BigInt(latestNonce));
  const unsigned = await client.prepareFrameTransaction({ sender: account.address, frames: template.frames, maxFeePerGas: template.fees.maxFeePerGas, nonceSeq: BigInt(latestNonce) });
  const signed = await client.signFrameTransaction({ transaction: unsigned, signer: privateKeyToFrameSigner(state.participantKey) });
  const hash = codec.tx.txHash(codec.profile, signed);
  report.txHash = hash;
  report.nonce = latestNonce;
  report.transactionType = '0x06';
  report.balanceBefore = balanceBefore;
  report.frames = signed.frames;
  report.status = 'prepared';
  console.log(`Prepared: ${hash}`);
  console.log(`Pre-submission evidence: ${await writeEvidence('frame-prepared', report)}`);
  // Exactly one submission attempt. A timeout may still mean the node accepted it.
  report.status = 'submission-attempted';
  const returnedHash = await client.sendFrameTransaction({ transaction: signed });
  invariant(returnedHash?.toLowerCase() === hash.toLowerCase(), 'Gateway returned an unexpected transaction hash.');
  report.status = 'admitted';
  report.receipt = await client.waitForFrameReceipt({ hash, expectedFrameCount: 2, timeoutMs: cfg.receiptTimeoutMs, pollingIntervalMs: cfg.pollIntervalMs });
  report.status = 'included-awaiting-evidence';
  const chainTx = await rpc('eth_getTransactionByHash', [hash]);
  invariant(chainTx?.hash?.toLowerCase() === hash.toLowerCase() && BigInt(chainTx.type) === 6n, 'Included transaction is not the expected type-0x06 transaction.');
  invariant(chainTx.blockHash?.toLowerCase() === report.receipt.blockHash.toLowerCase(), 'Transaction and receipt block hashes differ.');
  report.admission = await getAdmissionEvidence(rpc, hash);
  report.sdkAdmission = await client.getFrameAdmission({ hash });
  report.balanceAfter = await rpc('eth_getBalance', [cfg.recipient, 'latest']);
  report.recipientBalanceDeltaWei = (BigInt(report.balanceAfter) - BigInt(balanceBefore)).toString();
  report.balanceNote = 'Balance observation may include concurrent transactions; successful frame receipts establish this transfer execution.';
  report.status = 'verified';
} catch (error) {
  report.error = safeError(error);
  if (rpc && report.txHash) {
    try { report.admission = await getAdmissionEvidence(rpc, report.txHash, { requireAccepted: false }); }
    catch (admissionError) { report.admissionError = safeError(admissionError); }
  }
  console.error(report.error.message);
  if (report.txHash) console.error(`Inspect ${report.txHash} with the workshop debugger before retrying; do not blindly resubmit.`);
  process.exitCode = 1;
} finally {
  if (release) await release();
  console.log(`Evidence: ${await writeEvidence('frame-result', report)}`);
}
console.log(`Frame smoke: ${report.status}`);
