import { defineCommand, defineHelper, defineModule, type CommandImportMap, type HelperImportMap, type WalletAction } from '@evmcrispr/sdk';
import { PRIVATE_METHOD, operationNames, privateIntent } from './requests';
import { encodePrivateFrame } from './frame-intent.mjs';
import { frameBudgets } from '../../../../poc/src/lib/frame-budgets';
import type { Hex } from 'viem';
import { privateAsset, privateTokens } from './assets';

const descriptions = {
  scan: 'Unlock and scan private balances and receiving addresses. Viewing access lasts five minutes.',
  shield: 'Shield public FPA or FPB into a private pocket. Amount is a quoted decimal; pool fee is 0.25%.',
  transfer: 'Transfer private tokens to another pocket or a 0zk address.',
  'add-inventory': 'Transfer tokens from --wallet to --inventory (both locally owned pockets).',
  'remove-inventory': 'Transfer tokens from --inventory to --wallet (both locally owned pockets).',
  swap: 'Swap FPB for FPA between --wallet and --inventory, both owned by this passkey. --expect fixes the exact output.',
  unshield: 'Withdraw private tokens to a public address. Recipient receives 99.75%.',
  quote: 'Refresh unlocked balances and print an exact-input FPB → FPA quote. Does not spend.',
  lock: 'Clear the private viewing session.',
};
const commands: CommandImportMap = {};
for (const name of operationNames) {
  const usesToken = ['shield', 'transfer', 'add-inventory', 'remove-inventory', 'unshield'].includes(name);
  const usesAmount = name !== 'scan' && name !== 'lock';
  const usesRecipient = name === 'transfer' || name === 'unshield';
  const command = defineCommand({
    name, description: descriptions[name], batchable: true,
    smartSupport: { kind: 'incompatible', reason: 'Use frame:tx with an ordinary batch for private operations, not a smart batch.' },
    args: [
      ...(usesToken ? [{ name: 'token', type: 'string' as const, description: 'FPA/FPB, a configured token address or @token("FPA"); A/B aliases also work' }] : []),
      ...(usesAmount ? [{ name: 'amount', type: 'string' as const, description: 'Quoted decimal token amount, e.g. "1.25"' }] : []),
      ...(usesRecipient ? [{ name: 'to', type: 'string' as const, description: name === 'transfer' ? 'Pocket or 0zk address' : 'Public recipient address' }] : []),
    ],
    opts: [
      ...(['scan', 'shield', 'transfer', 'swap', 'unshield', 'add-inventory', 'remove-inventory'].includes(name) ? [{ name: 'wallet', type: 'string' as const, description: 'Any locally owned pocket name, e.g. savings; legacy default: taker for swap, maker otherwise' }] : []),
      ...(['quote', 'swap', 'add-inventory', 'remove-inventory'].includes(name) ? [{ name: 'inventory', type: 'string' as const, description: 'Locally owned liquidity pocket name; defaults to inventory' }] : []),
      ...(name === 'scan' ? [{ name: 'wallets', type: 'string' as const, description: 'Comma-separated local pocket names to unlock, e.g. "savings,trading,liquidity"' }] : []),
      ...(name === 'swap' ? [{ name: 'expect', type: 'string' as const, description: 'Required exact FPA output, quoted decimal' }] : []),
    ],
    async run(module, args, { opts, interpreters }) {
      if (interpreters.simulation) throw new Error('Private operations cannot run in a simulated fork.');
      if (await module.getChainId() !== 1337) throw new Error('Private operations require Framecraft devnet (1337).');
      const request = privateIntent(name, args, opts);
      const inFrame = module.context.modules.some(m => m.name === 'frame' && 'depth' in m && Number(m.depth) > 0);
      if (inFrame) {
        if (['scan', 'quote', 'lock'].includes(request.action)) throw new Error('Move privacy:scan, privacy:quote and privacy:lock outside frame:tx.');
        // Upstream frame/batch layout preserves calldata and gas. No proof or signing at interpretation time.
        return [{ to: await module.getSender(), data: encodePrivateFrame(request) as Hex, value: 0n, gas: frameBudgets.quantum.execution }];
      }
      if (interpreters.batchContext) throw new Error('Put private batch commands inside frame:tx.');
      const action: WalletAction = { type: 'wallet', method: PRIVATE_METHOD, params: [request] };
      return [action];
    },
  });
  commands[name] = { load: async () => ({ default: command }), description: descriptions[name] };
}
const token = defineHelper({
  name: 'token', description: 'Resolve FPA/FPB to their configured Framecraft private token addresses.',
  returnType: 'address', args: [{ name: 'symbolOrAddress', type: 'string', description: 'FPA, FPB or a configured token address' }],
  async run(module, { symbolOrAddress }) {
    if (await module.getChainId() !== 1337) throw new Error('Private token symbols require Framecraft devnet (1337).');
    return privateTokens[privateAsset(symbolOrAddress)];
  },
});
const helpers: HelperImportMap = {
  token: { load: async () => ({ default: token }), description: 'Resolve the configured FPA/FPB token address; import with load privacy [@token].',
    returnType: 'address', hasArgs: true, argDefs: [{ name: 'symbolOrAddress', type: 'string' }] },
};
export default class Privacy extends defineModule('privacy', commands, helpers) {}
