import { isAddress, parseUnits } from 'viem';
import type { Pocket, BrowserPrivateRequest } from '../../../../../scripts/private/browser/types';
import { privateAsset } from './assets';
import { pocketName, pocketList } from '../../../../../scripts/private/browser/pockets';

export const PRIVATE_METHOD = 'framepay_private';
export const operationNames = ['scan', 'shield', 'transfer', 'add-inventory', 'remove-inventory', 'swap', 'unshield', 'quote', 'lock'] as const;
export type PrivateOperation = typeof operationNames[number];
export type PrivateIntent = BrowserPrivateRequest | { action: 'quote'; amount: string; inventory: Pocket } | { action: 'lock' };
function pocket(value: unknown, fallback: Pocket): Pocket {
  return pocketName(value === undefined ? fallback : value);
}
function amount(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,4})(?:\.\d{1,18})?$/.test(value)
    || parseUnits(value, 18) <= 0n || parseUnits(value, 18) > parseUnits('10000', 18))
    throw new Error('Use a quoted decimal amount greater than zero and at most 10,000 (18 decimals maximum).');
  return value;
}
/** Pure intent construction: no wallet unlock, RPC, proof generation or signing. */
export function privateIntent(action: PrivateOperation, args: Record<string, unknown>, opts: Record<string, unknown>): PrivateIntent {
  if (action === 'lock') return { action };
  if (action === 'quote') return { action, amount: amount(args.amount), inventory: pocket(opts.inventory, 'inventory') };
  const wallet = pocket(opts.wallet, action === 'swap' ? 'taker' : 'maker');
  const request: BrowserPrivateRequest = { action, wallet, receiver: 'taker', token: 'A' };
  if (opts.pockets !== undefined) request.pockets = pocketList(opts.pockets);
  if (action === 'scan') {
    if (opts.wallets !== undefined) {
      if (typeof opts.wallets !== 'string') throw new Error('Use a comma-separated list of local pocket names.');
      request.pockets = pocketList(opts.wallets.split(',').map(name => name.trim()));
    }
    return request;
  }
  request.amount = amount(args.amount);
  if (action === 'swap') {
    request.inventory = pocket(opts.inventory, 'inventory');
    if (wallet === request.inventory) throw new Error('Swap payer must differ from the inventory pocket.');
    request.token = 'B';
    request.expectedOutput = amount(opts.expect);
    return request;
  }
  request.token = privateAsset(args.token);
  if (action === 'add-inventory') request.receiver = pocket(opts.inventory, 'inventory');
  if (action === 'remove-inventory') { request.wallet = pocket(opts.inventory, 'inventory'); request.receiver = wallet; }
  if (['add-inventory', 'remove-inventory'].includes(action) && request.wallet === request.receiver) throw new Error('Choose another inventory pocket.');
  if (action === 'transfer') {
    if (typeof args.to !== 'string') throw new Error('Provide a recipient pocket or 0zk private address.');
    if (isAddress(args.to)) throw new Error('Private transfers require a pocket or 0zk address. Use privacy:unshield to send to a public address such as @me.');
    if (args.to.startsWith('0zk')) {
      if (!/^0zk[0-9a-z]{50,126}$/.test(args.to)) throw new Error('Invalid private recipient address.');
      request.privateRecipient = args.to;
    } else {
      request.receiver = pocket(args.to, 'taker');
      if (wallet === request.receiver) throw new Error('Choose another recipient pocket.');
    }
  }
  if (action === 'unshield') {
    if (typeof args.to !== 'string' || !isAddress(args.to) || /^0x0{40}$/i.test(args.to)) throw new Error('Provide a nonzero public recipient.');
    request.recipient = args.to;
  }
  return request;
}
/** Revalidate handler inputs, including requests from arbitrary wallet commands. */
export function validatePrivateIntent(value: unknown): PrivateIntent {
  if (!value || typeof value !== 'object') throw new Error('Invalid private intent.');
  const v = value as Record<string, unknown>;
  if (!operationNames.includes(v.action as PrivateOperation)) throw new Error('Unknown private operation.');
  return privateIntent(v.action as PrivateOperation,
    { amount: v.amount, token: v.token, to: v.privateRecipient ?? v.recipient ?? v.receiver },
    { wallet: v.action === 'remove-inventory' ? v.receiver : v.wallet, expect: v.expectedOutput, pockets: v.pockets,
      inventory: v.action === 'add-inventory' ? v.receiver : v.action === 'remove-inventory' ? v.wallet : v.inventory });
}
