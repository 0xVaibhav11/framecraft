export const actions = ['initialize', 'shield', 'transfer', 'add-inventory', 'swap', 'remove-inventory', 'unshield', 'inspect'] as const;
export type PrivateAction = typeof actions[number];
export type WalletName = 'maker' | 'taker' | 'inventory';
export type TokenName = 'A' | 'B';
export interface PrivateActionRequest {
  action: PrivateAction;
  expectedRevision?: string;
  wallet?: WalletName;
  receiver?: WalletName;
  token?: TokenName;
  amount?: string;
  recipient?: string;
  expectedOutput?: string;
}
export interface PrivateActivity {
  hash: string; label: string; at: string; status: 'pending' | 'confirmed' | 'failed';
  frameCount: number; blockNumber?: string;
}
export interface PrivatePocState {
  revision: string; network: 'devnet'; rpcUrl: string; genesis: string;
  initialized: boolean; stage: string; error?: string;
  contracts?: { pool: string; swap: string; aqua: string; tokenA: string; tokenB: string };
  submitter?: string;
  balances?: Record<WalletName, Record<TokenName, string>>;
  spendable?: Record<WalletName, Record<TokenName, string>>;
  activity: PrivateActivity[];
  pending?: PrivateActivity;
}
export interface PrivateJobStatus {
  running: boolean; enabled: boolean; message?: string; state: PrivatePocState | null;
}
/** Only fixed demo operations and bounded decimal amounts can cross the POC API. */
export function validatePrivateAction(value: unknown): asserts value is PrivateActionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid private action.');
  const input = value as Record<string, unknown>;
  const fields = ['action', 'expectedRevision', 'wallet', 'receiver', 'token', 'amount', 'recipient', 'expectedOutput'];
  if (Object.keys(input).some(key => !fields.includes(key)) || !actions.includes(input.action as PrivateAction)) throw new Error('Unsupported private action.');
  if (input.expectedRevision !== undefined && (typeof input.expectedRevision !== 'string' || input.expectedRevision.length > 64)) throw new Error('Invalid review revision.');
  for (const name of ['wallet', 'receiver']) if (input[name] !== undefined && !['maker', 'taker', 'inventory'].includes(String(input[name]))) throw new Error('Choose a test wallet.');
  if (input.token !== undefined && !['A', 'B'].includes(String(input.token))) throw new Error('Choose token A or B.');
  for (const name of ['amount', 'expectedOutput']) if (input[name] !== undefined && (typeof input[name] !== 'string' || !/^(?:0|[1-9]\d{0,4})(?:\.\d{1,18})?$/.test(input[name] as string) || Number(input[name]) <= 0 || Number(input[name]) > 10000)) throw new Error('Enter an amount between 0 and 10,000 with at most 18 decimals.');
  if (input.recipient !== undefined && (typeof input.recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(input.recipient) || /^0x0{40}$/.test(input.recipient))) throw new Error('Enter a nonzero recipient address.');
  if (!['initialize', 'inspect'].includes(String(input.action)) && (input.amount === undefined || !input.expectedRevision)) throw new Error('Review this action before sending.');
  if (input.action === 'swap' && input.expectedOutput === undefined) throw new Error('Review the current swap output.');
  if (input.action === 'unshield' && input.recipient === undefined) throw new Error('Choose a public withdrawal recipient.');
}
