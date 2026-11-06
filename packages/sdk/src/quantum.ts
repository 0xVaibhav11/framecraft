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
async function prfApproval(credential: PasskeyCredential, challenge: Hex) {
  if (!globalThis.isSecureContext || typeof window === 'undefined' || window.top !== window.self || location.origin !== credential.origin || location.hostname !== credential.rpId) throw new Error('Open the original passkey site directly over HTTPS or localhost.');
  const result = await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(hexToBytes(challenge)), rpId: credential.rpId,
    allowCredentials: [{ type: 'public-key', id: fromBase64url(credential.credentialId) }], userVerification: 'required', timeout: 60_000,
    extensions: { prf: { eval: { first: hexToBytes(FALCON_PRF_SALT) } } } as AuthenticationExtensionsClientInputs,
  } }) as PublicKeyCredential | null;
  if (!result) throw new Error('Passkey approval cancelled.');
  const seed = (result.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results?.first;
  if (!seed || seed.byteLength !== 32) throw new Error('This credential cannot produce the required PRF seed. No fallback signature is allowed.');
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
