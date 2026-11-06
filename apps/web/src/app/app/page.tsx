import type { Metadata } from "next";
import { DefiApp } from "@/components/defi/defi-app";
export const metadata: Metadata = { title: "DeFi app — Swap, transfer and set your rules" };
export default function Page() { return <DefiApp />; }
