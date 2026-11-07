import type { BrowserPrivateIntent, BrowserPrivateRequest, Pocket } from './types.ts';

// Keep these derivation labels unchanged so existing POC notes remain recoverable.
export const legacyPockets = ['maker', 'taker', 'inventory'] as const;
export const MAX_PRIVATE_POCKETS = 64;

export function pocketName(value: unknown): Pocket {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)
    || ['constructor', 'prototype'].includes(value))
    throw new Error('A private pocket name must start with a lowercase letter and contain at most 32 lowercase letters, digits, underscores or hyphens. Public/private addresses cannot select a locally owned pocket.');
  return value;
}

export function pocketList(value: unknown): Pocket[] {
  if (!Array.isArray(value) || value.length > MAX_PRIVATE_POCKETS) throw new Error(`Use at most ${MAX_PRIVATE_POCKETS} private pockets per wallet.`);
  return [...new Set(value.map(pocketName))];
}

/** Resolve roles per operation. Swap's two roles may use any distinct owned pockets. */
export function privateParticipants(request: BrowserPrivateRequest) {
  const wallet = pocketName(request.wallet), receiver = pocketName(request.receiver);
  const inventory = pocketName(request.inventory ?? 'inventory');
  if (request.action === 'swap' && wallet === inventory) throw new Error('Swap payer must differ from the inventory pocket.');
  return { wallet, receiver, inventory };
}

export function collectPrivatePockets(intent: BrowserPrivateIntent): Pocket[] {
  const names = new Set<Pocket>(legacyPockets);
  const add = (value: unknown) => { for (const name of pocketList(value)) names.add(name); };
  add(intent.pockets ?? []);
  for (const request of intent.action === 'frame-batch' ? intent.requests : [intent]) {
    const { wallet, receiver, inventory } = privateParticipants(request);
    add([wallet, receiver, ...(request.action === 'swap' ? [inventory] : [])]);
    add(request.pockets ?? []);
  }
  return pocketList([...names]);
}

/** This exact domain string also derives the legacy maker/taker/inventory addresses. */
export async function privatePocketEntropy(key: CryptoKey, name: Pocket): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(`FramePay.PrivatePocket.v1:${pocketName(name)}`)));
}
