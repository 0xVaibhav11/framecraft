import { NextRequest } from "next/server";
import { handleRpc } from "@/lib/rpc-handler.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return handleRpc(request, { gateway: process.env.FRAMEPAY_RPC_URL });
}
