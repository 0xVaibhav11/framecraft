import { Data, Effect } from 'effect';

export class PrivacyError extends Data.TaggedError('PrivacyError')<{
  readonly operation: string;
  readonly message: string;
  readonly rpcCode?: number;
  readonly rpcReason?: 'execution-reverted' | 'validation-gas-limit';
  readonly transactionHash?: string;
}> {}

/** Keep raw SDK errors out of logs: they can contain witnesses or wallet material. */
export const attempt = <A>(operation: string, action: () => Promise<A>) =>
  Effect.tryPromise({ try: action, catch: (error) => error instanceof PrivacyError ? error : new PrivacyError({ operation, message: `${operation} failed` }) });

export const check = (condition: boolean, message: string): void => {
  if (!condition) throw new PrivacyError({ operation: 'validation', message });
};
