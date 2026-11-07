import { bytesToHex, encodeAbiParameters, hexToBytes, keccak256, parseAbi, parseAbiParameters, stringToHex, type Hex } from 'viem';
import { fromBase64url, parsePasskeyProof, registerPasskey, type PasskeyCredential, type WalletCall } from './passkey.js';

export const FALCON_PRF_SALT = keccak256(stringToHex('FramePay.ETHFALCON.v1'));
export type QuantumCredential = PasskeyCredential & { falconPublicKey: Hex[] };
export type QuantumProof = { falconSalt: Hex; falconSignature: bigint[] };
export const quantumWalletAbi = parseAbi([
  'struct Call { address target; uint256 value; bytes data; }',
  'struct Auth { bytes falconSalt; uint256[] falconSignature; }',
  'function networkDomain() view returns (bytes32)', 'function nonce() view returns (uint256)',
  'function falconKeyHash() view returns (bytes32)', 'function verifier() view returns (address)', 'function verifierCodeHash() view returns (bytes32)',
  'function challenge(Call[] calls, uint256 sequence, uint256 deadline) view returns (bytes32)',
  'function verify(Call[] calls, uint256 sequence, uint256 deadline, Auth auth) view returns (bool)',
  'function execute(Call[] calls, uint256 sequence, uint256 deadline, Auth auth)',
]);
export const quantumFactoryAbi = parseAbi([
  'function verifier() view returns (address)', 'function verifierCodeHash() view returns (bytes32)',
  'function predict(bytes32 network, bytes32 salt, uint256[] key) view returns (address)',
  'function createWallet(bytes32 network, bytes32 salt, uint256[] key) returns (address)',
]);
export function validateFalconKey(key: unknown): asserts key is Hex[] {
  if (!Array.isArray(key) || key.length !== 32 || key.some(w => typeof w !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(w))) throw new Error('Invalid Falcon public key.');
  let nonzero = 0n;
  for (const word of key) {
    const value = BigInt(word); nonzero |= value;
    for (let j = 0n; j < 16n; j++) if (((value >> (16n * j)) & 65535n) >= 12289n) throw new Error('Invalid Falcon coefficient.');
  }
  if (!nonzero) throw new Error('Invalid zero Falcon key.');
}
export function falconKeyHash(key: readonly Hex[]) { return keccak256(encodeAbiParameters(parseAbiParameters('uint256[]'), [key.map(BigInt)])); }
export function quantumFactoryArgs(credential: QuantumCredential, network: Hex) {
  validateFalconKey(credential.falconPublicKey);
  return [network, keccak256(fromBase64url(credential.credentialId)), credential.falconPublicKey.map(BigInt)] as const;
}
export function quantumChallenge(args: { chainId: bigint; wallet: Hex; networkDomain: Hex; nonce: bigint; deadline: bigint; calls: readonly WalletCall[] }): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters('bytes32, uint256, address, bytes32, uint256, uint256, bytes32'), [keccak256(stringToHex('FramePay.QuantumWallet.v1')), args.chainId, args.wallet, args.networkDomain, args.nonce, args.deadline, keccak256(encodeAbiParameters(parseAbiParameters('(address target, uint256 value, bytes data)[]'), [args.calls]))]));
}
type FalconResult = { publicKey: Hex[]; salt?: Hex; signature?: Hex[] };
/** Transfer ownership of the PRF buffer to a short-lived worker, never storage or a server. */
export function runFalcon(seed: ArrayBuffer, challenge?: Hex): Promise<FalconResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    const timer = setTimeout(() => { worker?.terminate(); reject(new Error('Falcon signer timed out.')); }, 60_000);
    try {
      worker = new Worker('/ethfalcon/worker.mjs', { type: 'module' });
      worker.onmessage = event => { clearTimeout(timer); worker?.terminate(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result); };
      worker.onerror = () => { clearTimeout(timer); worker?.terminate(); reject(new Error('ETHFalcon signer unavailable. Run npm run quantum:build.')); };
      worker.postMessage({ seed, digest: challenge ? hexToBytes(challenge).buffer : undefined }, [seed]);
    } catch (error) { clearTimeout(timer); worker?.terminate(); if (seed.byteLength) new Uint8Array(seed).fill(0); reject(error); }
  });
}
/** Copy a 32-byte PRF output into a fresh ArrayBuffer the page owns, then wipe the source.
 * Browsers differ in what they return (Firefox can hand back a typed array), and only an owned
 * ArrayBuffer can go in the worker's postMessage transfer list. */
export function ownedPrfSeed(raw: BufferSource | undefined): ArrayBuffer | undefined {
  if (!raw) return undefined;
  const source = ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);
  if (source.byteLength !== 32) return undefined;
  const seed = source.slice().buffer;
  source.fill(0);
  return seed;
}
async function prfApproval(credential: PasskeyCredential, challenge: Hex, signal?: AbortSignal) {
  if (!globalThis.isSecureContext || typeof window === 'undefined' || window.top !== window.self || location.origin !== credential.origin || location.hostname !== credential.rpId) throw new Error('Open the original passkey site directly over HTTPS or localhost.');
  const result = await navigator.credentials.get({ signal, publicKey: { challenge: new Uint8Array(hexToBytes(challenge)), rpId: credential.rpId,
    allowCredentials: [{ type: 'public-key', id: fromBase64url(credential.credentialId) }], userVerification: 'required', timeout: 60_000,
    extensions: { prf: { eval: { first: hexToBytes(FALCON_PRF_SALT) } } } as AuthenticationExtensionsClientInputs,
  } }) as PublicKeyCredential | null;
  if (!result) throw new Error('Passkey approval cancelled.');
  const seed = ownedPrfSeed((result.getClientExtensionResults() as { prf?: { results?: { first?: BufferSource } } }).prf?.results?.first);
  if (!seed) throw new Error('This credential cannot produce the required PRF seed. No fallback signature is allowed.');
  try {
    parsePasskeyProof(result.response as AuthenticatorAssertionResponse, credential, challenge);
    return { seed };
  } catch (error) { new Uint8Array(seed).fill(0); throw error; }
}
export async function registerQuantumPasskey(): Promise<QuantumCredential> {
  const credential = await registerPasskey(true);
  const approval = await prfApproval(credential, bytesToHex(crypto.getRandomValues(new Uint8Array(32))));
  const result = await runFalcon(approval.seed);
  validateFalconKey(result.publicKey);
  return { ...credential, falconPublicKey: result.publicKey };
}
export async function signWithQuantumPasskey(credential: QuantumCredential, challenge: Hex): Promise<QuantumProof> {
  validateFalconKey(credential.falconPublicKey);
  const { seed } = await prfApproval(credential, challenge);
  const result = await runFalcon(seed, challenge);
  if (falconKeyHash(result.publicKey) !== falconKeyHash(credential.falconPublicKey) || !result.salt || !result.signature) throw new Error('The PRF-derived Falcon key differs from this wallet.');
  return { falconSalt: result.salt, falconSignature: result.signature.map(BigInt) };
}

/** Separate privacy entropy. Neither this entropy nor the Falcon PRF seed may be stored or sent to a server. */
export async function unlockQuantumPrivacy(credential: QuantumCredential, networkDomain: Hex, wallet: Hex): Promise<ArrayBuffer> {
  validateFalconKey(credential.falconPublicKey);
  if (!/^0x[\da-fA-F]{64}$/.test(networkDomain) || !/^0x[\da-fA-F]{40}$/.test(wallet)) throw new Error('Invalid private wallet domain.');
  const { seed } = await prfApproval(credential, bytesToHex(crypto.getRandomValues(new Uint8Array(32))));
  let entropy: ArrayBuffer | undefined;
  try {
    const key = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits']);
    entropy = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(hexToBytes(networkDomain)),
      info: new TextEncoder().encode(`FramePay.PrivateWallet.v1:${wallet.toLowerCase()}`) }, key, 256);
    // Check the selected credential still derives the recorded ETHFalcon owner.
    const owner = await runFalcon(seed);
    if (falconKeyHash(owner.publicKey) !== falconKeyHash(credential.falconPublicKey)) throw new Error('The passkey does not own this quantum wallet.');
    return entropy;
  } catch (error) { if (entropy) new Uint8Array(entropy).fill(0); throw error; }
  finally { if (seed.byteLength) new Uint8Array(seed).fill(0); }
}

/** One approval for an immutable private intent. Transfer the returned buffer immediately to a bounded operation worker.
 * The worker MUST verify the derived Falcon owner before using it. Never cache this seed for another operation. */
export async function approveQuantumPrivateIntent(credential: QuantumCredential, networkDomain: Hex, wallet: Hex, intentHash: Hex, signal?: AbortSignal): Promise<ArrayBuffer> {
  validateFalconKey(credential.falconPublicKey);
  if (![networkDomain,intentHash].every(v=>/^0x[\da-fA-F]{64}$/.test(v)) || !/^0x[\da-fA-F]{40}$/.test(wallet)) throw new Error('Invalid private intent domain.');
  const challenge = keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32, address, bytes32, bytes32'),
    [keccak256(stringToHex('FramePay.PrivateApproval.v1')),networkDomain,wallet,intentHash,bytesToHex(crypto.getRandomValues(new Uint8Array(32)))]));
  return (await prfApproval(credential,challenge,signal)).seed;
}
