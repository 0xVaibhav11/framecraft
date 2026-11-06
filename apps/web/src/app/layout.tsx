import type { Metadata } from "next";
import { Shell } from "@/components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "FramePay — Native account abstraction, one client",
    template: "%s · FramePay SDK",
  },
  description:
    "Typed viem actions for EIP-8141 frame transactions. Read the docs and test a transaction on your local devnet.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
