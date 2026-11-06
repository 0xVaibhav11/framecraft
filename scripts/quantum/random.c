// Browser entropy adapter for the pinned ETHFalcon C sources (MIT).
// Never link the upstream KAT/test RNG into the application signer.
#include <emscripten.h>
EM_JS(int, framepay_random, (unsigned char *out, unsigned int len), {
    if (!globalThis.crypto || !globalThis.crypto.getRandomValues) throw new Error('Secure randomness unavailable');
    globalThis.crypto.getRandomValues(HEAPU8.subarray(out, out + len));
    return 0;
});
int randombytes(unsigned char *out, unsigned long long len) {
    if (len > 65536) return -1;
    return framepay_random(out, (unsigned int)len);
}
