import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/code-block";
import { Icon } from "@/components/icon";
import { clientCode } from "@/lib/docs";

export const metadata: Metadata = { title: "Quickstart" };
export default function Quickstart() {
  return (
    <main id="main-content" className="docs-layout">
      <article className="article">
        <div className="eyebrow">GET STARTED</div>
        <h1 className="doc-title">Your first frame transaction.</h1>
        <p className="hero-description">
          Go from a local workspace to a signed transaction, then follow it
          through the sidecar and into a block.
        </p>
        <div className="preview-notice">
          <Icon name="info" />
          <div>
            <strong>Local workspace preview</strong>
            <p>
              The package is not published to npm yet. These steps use this
              repository and the installed dependencies in the sibling workshop
              checkout.
            </p>
          </div>
        </div>
        <section className="section-block" id="setup">
          <h2>
            <span className="inline-number">01</span>Set up the workspace
          </h2>
          <p>
            Use Node 20.12 or later and the prepared local workshop. The
            bootstrap links its pinned dependencies without changing the
            workshop.
          </p>
          <CodeBlock
            title="Terminal · FramePay directory"
            code={"npm run sdk:bootstrap\nnpm test\nnpm run devnet:inspect"}
          />
          <p>
            The local gateway should respond on port <code>14337</code>, with
            chain ID <code>1337</code>. A new local chain must reach its
            configured Hegota activation before it can execute frames.
          </p>
        </section>
        <section className="section-block" id="client">
          <h2>
            <span className="inline-number">02</span>Extend your viem client
          </h2>
          <CodeBlock code={clientCode} title="client.ts" />
        </section>
        <section className="section-block" id="run">
          <h2>
            <span className="inline-number">03</span>Run the complete smoke flow
          </h2>
          <p>
            The smoke runner uses the existing workshop participant, preserves
            its progress, and records the expected transaction hash before
            submission.
          </p>
          <CodeBlock title="Terminal" code="npm run devnet:smoke" />
          <p>
            It checks the transaction type, both frame receipts, and admission
            evidence. Evidence files are saved under{" "}
            <code>evidence/milestone-1/</code>. A successful offline test is
            separate from a successful devnet transaction.
          </p>
        </section>
        <section className="section-block" id="browser">
          <h2>
            <span className="inline-number">04</span>Try the browser playground
          </h2>
          <p>
            Create a disposable account in this tab, fund it using the local
            faucet, and walk through the SDK one action at a time. The example
            is self-paid and uses SECP256K1 authorization.
          </p>
          <Link className="button primary" href="/playground">
            Open playground <Icon name="arrow" size={16} />
          </Link>
        </section>
        <Link className="next-page" href="/docs/prepare">
          <span>
            <small>EXPLORE THE API</small>
            <strong>Prepare a transaction</strong>
          </span>
          <Icon name="arrow" />
        </Link>
      </article>
      <aside className="page-aside">
        <p className="aside-label">ON THIS PAGE</p>
        <a href="#setup">Set up the workspace</a>
        <a href="#client">Create a client</a>
        <a href="#run">Run the smoke flow</a>
        <a href="#browser">Try it in your browser</a>
      </aside>
    </main>
  );
}
