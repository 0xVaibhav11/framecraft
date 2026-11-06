// One worker / WASM instance per operation. Public keys and signatures alone leave it.
import createModule from './falcon.mjs';
function hex(bytes) { return '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
function compact(bytes) {
  if (bytes.length !== 1024) throw new Error('Invalid polynomial length');
  const words = [];
  for (let i = 0; i < 32; i++) {
    let word = 0n;
    for (let j = 0; j < 16; j++) {
      const at = (16 * i + j) * 2, coefficient = bytes[at] * 256 + bytes[at + 1];
      if (coefficient >= 12289) throw new Error('Invalid polynomial coefficient');
      word |= BigInt(coefficient) << BigInt(j * 16);
    }
    words.push('0x' + word.toString(16).padStart(64, '0'));
  }
  return words;
}
export async function operate(seed, digest) {
  let m;
  try {
    if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('Expected a 32-byte PRF seed');
    if (digest && (!(digest instanceof Uint8Array) || digest.length !== 32)) throw new Error('Expected a 32-byte challenge');
    m = await createModule();
    const pk = m._malloc(1025), sk = m._malloc(1281), seedAt = m._malloc(32);
    m.HEAPU8.set(seed, seedAt);
    if (m._zknox_crypto_sign_keypair_from_seed(pk, sk, seedAt, 32) !== 0) throw new Error('Falcon key generation failed');
    const publicKey = compact(m.HEAPU8.slice(pk + 1, pk + 1025));
    if (!digest) return { publicKey };
    const msg = m._malloc(32), signed = m._malloc(1099), len = m._malloc(8);
    m.HEAPU8.set(digest, msg);
    if (m._zknox_crypto_sign(signed, len, msg, 32n, sk) !== 0) throw new Error('Falcon signing failed');
    if (new DataView(m.HEAPU8.buffer).getBigUint64(len, true) !== 1099n) throw new Error('Unexpected signature encoding');
    // Upstream format: u16 signature length || salt[40] || digest[32] || header || s2[1024].
    const recovered = m._malloc(1099), recoveredLen = m._malloc(8);
    if (m._zknox_crypto_sign_open(recovered, recoveredLen, signed, 1099n, pk) !== 0) throw new Error('Falcon self verification failed');
    return { publicKey, salt: hex(m.HEAPU8.slice(signed + 2, signed + 42)), signature: compact(m.HEAPU8.slice(signed + 75, signed + 1099)) };
  } finally {
    seed.fill(0);
    // Includes private key, keygen/signing scratch and C stack, not only malloc buffers.
    // JavaScript runtimes/hardware can retain copies; this is best-effort, not a timing guarantee.
    m?.HEAPU8.fill(0);
  }
}
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = async event => {
    try { self.postMessage({ result: await operate(new Uint8Array(event.data.seed), event.data.digest ? new Uint8Array(event.data.digest) : undefined) }); }
    catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Falcon signing failed' }); }
    finally { self.close(); }
  };
}
