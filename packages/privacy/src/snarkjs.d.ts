declare module 'snarkjs' {
  export const groth16: {
    fullProve(inputs: Partial<Record<string, bigint | bigint[] | bigint[][]>>, wasm: Uint8Array, zkey: Uint8Array,
      logger?: unknown, witnessOptions?: unknown, proverOptions?: { singleThread: boolean }): Promise<{
        proof: import('@railgun-community/engine').Proof; publicSignals: string[];
      }>;
    verify(vkey: object, signals: bigint[], proof: import('@railgun-community/engine').Proof): Promise<boolean>;
  };
}
