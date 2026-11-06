import { bytesToHex, encodeAbiParameters, hexToBytes, keccak256, parseAbi, parseAbiParameters, sha256, stringToHex, type Address, type Hex } from 'viem';

export type PasskeyCredential = { credentialId: string; qx: Hex; qy: Hex; rpId: string; origin: string };
export type WalletCall = { target: Address; value: bigint; data: Hex };
export type PasskeyProof = { assertion: { r: Hex; s: Hex; challengeIndex: bigint; typeIndex: bigint; authenticatorData: Hex; clientDataJSON: string }; originIndex: bigint; originLength: bigint; crossOriginIndex: bigint };
export const passkeyWalletAbi = parseAbi([
  'struct Call { address target; uint256 value; bytes data; }',
  'struct Assertion { bytes32 r; bytes32 s; uint256 challengeIndex; uint256 typeIndex; bytes authenticatorData; string clientDataJSON; }',
  'struct Auth { Assertion assertion; uint256 originIndex; uint256 originLength; uint256 crossOriginIndex; }',
  'function qx() view returns (bytes32)', 'function qy() view returns (bytes32)', 'function rpIdHash() view returns (bytes32)',
  'function originHash() view returns (bytes32)', 'function networkDomain() view returns (bytes32)', 'function nonce() view returns (uint256)',
  'function challenge(Call[] calls, uint256 sequence, uint256 deadline) view returns (bytes32)',
  'function verify(Call[] calls, uint256 sequence, uint256 deadline, Auth auth) view returns (bool)',
  'function execute(Call[] calls, uint256 sequence, uint256 deadline, Auth auth)',
]);
export const passkeyFactoryAbi = parseAbi([
  'function predict(bytes32 x, bytes32 y, bytes32 rp, bytes32 origin, bytes32 network, bytes32 salt) view returns (address)',
  'function createWallet(bytes32 x, bytes32 y, bytes32 rp, bytes32 origin, bytes32 network, bytes32 salt) returns (address)',
]);
export function passkeyFactoryArgs(credential: PasskeyCredential, networkDomain: Hex) {
  return [credential.qx, credential.qy, sha256(stringToHex(credential.rpId)), keccak256(stringToHex(credential.origin)), networkDomain, keccak256(fromBase64url(credential.credentialId))] as const;
}
export function passkeyChallenge({ chainId, wallet, networkDomain, nonce, deadline, calls }: { chainId: bigint; wallet: Address; networkDomain: Hex; nonce: bigint; deadline: bigint; calls: readonly WalletCall[] }): Hex {
  const callsHash = keccak256(encodeAbiParameters(parseAbiParameters('(address target, uint256 value, bytes data)[]'), [calls]));
  return keccak256(encodeAbiParameters(parseAbiParameters('bytes32, uint256, address, bytes32, uint256, uint256, bytes32'),
    [keccak256(stringToHex('FramePay.PasskeyWallet.v1')), chainId, wallet, networkDomain, nonce, deadline, callsHash]));
}
export function toBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid credential encoding.');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0));
  if (toBase64url(bytes) !== value) throw new Error('Noncanonical credential encoding.');
  return bytes;
}
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/** Strict DER parser; normalize high-S signatures emitted by WebAuthn authenticators for OZ P256. */
export function decodeP256Signature(bytes: Uint8Array): { r: Hex; s: Hex } {
  if (bytes.length < 8 || bytes.length > 72 || bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) throw new Error('Invalid P-256 signature sequence.');
  let offset = 2;
  const integer = () => {
    if (bytes[offset++] !== 0x02) throw new Error('Invalid signature integer.');
    const size = bytes[offset++];
    if (!size || size > 33 || offset + size > bytes.length) throw new Error('Invalid signature integer length.');
    const value = bytes.slice(offset, offset + size); offset += size;
    if (value[0] & 0x80 || (size > 1 && value[0] === 0 && !(value[1] & 0x80))) throw new Error('Noncanonical signature integer.');
    const number = BigInt(bytesToHex(value));
    if (number <= 0n || number >= P256_N) throw new Error('Signature scalar outside P-256 range.');
    return number;
  };
  const r = integer(); let s = integer();
  if (offset !== bytes.length) throw new Error('Trailing signature bytes.');
  if (s > P256_N / 2n) s = P256_N - s;
  return { r: `0x${r.toString(16).padStart(64, '0')}`, s: `0x${s.toString(16).padStart(64, '0')}` };
}
function requireBrowser() {
  if (typeof window === 'undefined' || !window.isSecureContext || !navigator.credentials || !window.PublicKeyCredential) throw new Error('Passkeys require a supported browser on HTTPS or localhost.');
  if (window.top !== window.self) throw new Error('Open the app directly to use a passkey.');
  if (/^[\d.]+$/.test(location.hostname) || location.hostname.includes(':')) throw new Error('Open http://localhost:3000/app to create a passkey; IP-address origins are not supported.');
}
/** Creates a resident ES256 credential. The authenticator retains the private key. */
export async function registerPasskey(): Promise<PasskeyCredential> {
  requireBrowser();
  const credential = await navigator.credentials.create({ publicKey: {
    rp: { name: 'FramePay', id: location.hostname }, user: { id: crypto.getRandomValues(new Uint8Array(32)), name: `wallet-${Date.now()}`, displayName: 'FramePay wallet' },
    challenge: crypto.getRandomValues(new Uint8Array(32)), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, attestation: 'none', timeout: 60_000,
  } }) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey creation was cancelled.');
  const response = credential.response as AuthenticatorAttestationResponse;
  if (response.getPublicKeyAlgorithm?.() !== -7) throw new Error('The authenticator must support ES256 passkeys.');
  const spki = response.getPublicKey?.();
  if (!spki) throw new Error('This browser cannot export the passkey public key. Try a current Chrome or Safari.');
  const publicKey = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  if (!jwk.x || !jwk.y) throw new Error('Missing passkey public key coordinates.');
  return { credentialId: toBase64url(new Uint8Array(credential.rawId)), qx: bytesToHex(fromBase64url(jwk.x)), qy: bytesToHex(fromBase64url(jwk.y)), rpId: location.hostname, origin: location.origin };
}
/** Parse exact authenticator-signed bytes without changing clientDataJSON. */
export function parsePasskeyProof(response: { signature: ArrayBuffer; authenticatorData: ArrayBuffer; clientDataJSON: ArrayBuffer }, credential: Pick<PasskeyCredential, 'origin' | 'rpId'>, challenge: Hex): PasskeyProof {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(response.clientDataJSON);
  const client = JSON.parse(text);
  if (client.type !== 'webauthn.get' || client.challenge !== toBase64url(hexToBytes(challenge)) || client.origin !== credential.origin || client.crossOrigin !== false) throw new Error('Passkey response does not match this request and origin.');
  const data = new Uint8Array(response.authenticatorData);
  if (data.length < 37 || data.length > 1024 || response.clientDataJSON.byteLength > 2048 || bytesToHex(data.slice(0,32)) !== sha256(stringToHex(credential.rpId)) || (data[32] & 5) !== 5) throw new Error('Passkey response requires matching RP ID, user presence and user verification.');
  const index = (needle: string) => {
    const value = text.indexOf(needle);
    if (value < 0 || text.indexOf(needle, value + 1) >= 0) throw new Error('Unsupported passkey client data encoding.');
    return BigInt(new TextEncoder().encode(text.slice(0, value)).length);
  };
  return { assertion: { ...decodeP256Signature(new Uint8Array(response.signature)), challengeIndex: index(`"challenge":"${client.challenge}"`), typeIndex: index('"type":"webauthn.get"'), authenticatorData: bytesToHex(data), clientDataJSON: text },
    originIndex: index(`"origin":"${credential.origin}"`), originLength: BigInt(new TextEncoder().encode(credential.origin).length), crossOriginIndex: index('"crossOrigin":false') };
}
export async function signWithPasskey(credential: PasskeyCredential, challenge: Hex): Promise<PasskeyProof> {
  requireBrowser();
  if (location.origin !== credential.origin || location.hostname !== credential.rpId) throw new Error(`Open ${credential.origin}/app to use this wallet’s passkey.`);
  const result = await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(hexToBytes(challenge)), rpId: credential.rpId,
    allowCredentials: [{ type: 'public-key', id: fromBase64url(credential.credentialId) }], userVerification: 'required', timeout: 60_000 } }) as PublicKeyCredential | null;
  if (!result || toBase64url(new Uint8Array(result.rawId)) !== credential.credentialId) throw new Error('Passkey approval was cancelled or the credential did not match.');
  return parsePasskeyProof(result.response as AuthenticatorAssertionResponse, credential, challenge);
}
