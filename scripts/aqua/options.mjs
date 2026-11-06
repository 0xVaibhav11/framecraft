export function demoOptions(args) {
  const usage = 'Usage: npm run aqua:demo [-- --run <name>] (FramePay or local disposable devnet).';
  if (![2, 4].includes(args.length) || args[0] !== '--network' || !['local', 'devnet'].includes(args[1])) throw new Error(usage);
  if (args.length === 2) return { runId: 'default', networkId: args[1] };
  if (args[2] !== '--run' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(args[3])) throw new Error(usage);
  return { runId: args[3], networkId: args[1] };
}
