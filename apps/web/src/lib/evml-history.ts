import { frameNetworks, type FrameNetworkId } from '@framepay/sdk';
import type { SentFrameTransaction } from './evml-frames';

const historyKey = (networkId: FrameNetworkId) => {
  const network = frameNetworks[networkId];
  return `framepay:evml:${networkId}:${'genesisHash' in network ? network.genesisHash : network.rpcUrl}:activity`;
};
const hashPattern = /^0x[\da-fA-F]{64}$/;
const status = (value: unknown) => value === '0x0' || value === '0x1';

function validEntry(value: unknown): value is SentFrameTransaction {
  if (!value || typeof value !== 'object') return false;
  const entry = value as SentFrameTransaction;
  if (typeof entry.hash !== 'string' || !hashPattern.test(entry.hash)
    || !Number.isInteger(entry.frameCount) || entry.frameCount < 1 || entry.frameCount > 16
    || (entry.outcome !== undefined && entry.outcome !== 'rejected')
    || (entry.error !== undefined && typeof entry.error !== 'string')) return false;
  if (entry.receipt === undefined) return true;
  const receipt = entry.receipt;
  return !!receipt && receipt.transactionHash === entry.hash
    && typeof receipt.blockHash === 'string' && hashPattern.test(receipt.blockHash)
    && typeof receipt.blockNumber === 'string' && /^0x[\da-fA-F]+$/.test(receipt.blockNumber)
    && status(receipt.status) && Array.isArray(receipt.frameReceipts)
    && receipt.frameReceipts.length === entry.frameCount
    && receipt.frameReceipts.every(frame => frame && status(frame.status));
}

export function loadFrameHistory(networkId: FrameNetworkId): SentFrameTransaction[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(historyKey(networkId)) ?? '[]');
    return Array.isArray(saved) ? saved.filter(validEntry).slice(0, 30) : [];
  } catch { return []; }
}

export function saveFrameHistory(networkId: FrameNetworkId, entries: SentFrameTransaction[]) {
  try { localStorage.setItem(historyKey(networkId), JSON.stringify(entries)); }
  catch { /* Keep transaction hashes visible in this session when storage is unavailable. */ }
}
