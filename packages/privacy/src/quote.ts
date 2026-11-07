import { check } from './errors.js';

/** Exact-input quote, shared by the proof worker and script host. */
export function quoteExactIn(amountIn: bigint, reserveOut: bigint, reserveIn: bigint): bigint {
  check(amountIn > 0n && reserveOut > 0n && reserveIn > 0n, 'Amount and reserves must be positive');
  check([amountIn, reserveOut, reserveIn].every((n) => n < 1n << 120n), 'Amounts must fit uint120');
  const amountOut = amountIn * reserveOut / (reserveIn + amountIn);
  check(amountOut > 0n, 'Quote rounds to zero');
  return amountOut;
}
