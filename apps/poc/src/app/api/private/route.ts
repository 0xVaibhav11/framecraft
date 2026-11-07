// Retire old clients explicitly: private signing now happens in a passkey-unlocked browser worker.
export function GET() {
  return Response.json({error:'Refresh the POC. Private actions now run in your browser with your passkey; test tokens come from the onchain faucet.'},{status:410});
}
export const POST = GET;
