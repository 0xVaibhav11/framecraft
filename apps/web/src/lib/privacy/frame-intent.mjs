import { hexToString, stringToHex } from 'viem';

// Compiler-only calldata. It must be replaced with wallet.execute before serialization.
export const PRIVATE_FRAME_PREFIX = '0x46525052495641544501';
export const isPrivateFrameData = data => typeof data === 'string' && data.toLowerCase().startsWith(PRIVATE_FRAME_PREFIX.toLowerCase());
export function encodePrivateFrame(request) {
  return `${PRIVATE_FRAME_PREFIX}${stringToHex(JSON.stringify(request)).slice(2)}`;
}
export function decodePrivateFrame(data) {
  if (!isPrivateFrameData(data) || data.length > 8192) throw new Error('Invalid private frame intent.');
  try { return JSON.parse(hexToString(`0x${data.slice(PRIVATE_FRAME_PREFIX.length)}`)); }
  catch { throw new Error('Invalid private frame intent.'); }
}
