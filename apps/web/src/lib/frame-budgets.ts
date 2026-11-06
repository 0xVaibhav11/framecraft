/** Shared by the transaction builder and the on-screen frame explanation. */
export const frameBudgets = {
  account: { execution: 30_000n, state: 0n },
  payment: { execution: 50_000n, state: 0n },
  eoa: { execution: 600_000n, state: 1_500_000n },
  wallet: { execution: 1_500_000n, state: 6_000_000n },
  deployment: { execution: 2_000_000n, state: 14_000_000n },
} as const;
