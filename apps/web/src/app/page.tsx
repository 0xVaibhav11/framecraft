import Link from "next/link";
import { Icon } from "@/components/icon";
import { CodeBlock } from "@/components/code-block";

const overviewCode = `// Extend your viem client with native frame actions.
const client = publicClient.extend(
  frameActions({ profile: 'ethrex-eip8141-tracer' }),
);

const signed = await client.signFrameTransaction({
  transaction, signer,
});

const hash = await client.sendFrameTransaction({
  transaction: signed,
});

const receipt = await client.waitForFrameReceipt({ hash });`;
export default function Overview() {
  return (
    <main id="main-content" className="docs-layout">
      <article className="article overview">
        <div className="eyebrow">
          <span className="eyebrow-line" />
          FRAME TRANSACTIONS, SIMPLIFIED
        </div>
        <h1>
          One client.
          <br />
          <span className="heading-muted">Every frame.</span>
        </h1>
        <p className="hero-description">
          A familiar developer experience for native account abstraction.
          Prepare, sign, and send EIP-8141 transactions with a few typed viem
          actions.
        </p>
        <div className="hero-actions">
          <Link className="button primary" href="/docs/quickstart">
            Start building <Icon name="arrow" size={16} />
          </Link>
          <Link className="button secondary" href="/app">
            <Icon name="wallet" size={16} />
            Open DeFi app
          </Link>
        </div>
        <div className="compatibility">
          <span>Made for your stack</span>
          <span className="stack-tag">
            <strong>viem</strong>
          </span>
          <span className="stack-tag">
            <span className="ts-logo">TS</span> TypeScript
          </span>
          <span className="stack-tag">
            <Icon name="layers" size={14} />
            EIP-8141
          </span>
        </div>

        <section className="section-block" id="workflow">
          <div className="section-heading">
            <h2>A clearer transaction lifecycle</h2>
            <span className="micro-label">FROM INTENT TO INCLUSION</span>
          </div>
          <div className="lifecycle-strip">
            {[
              ["01", "Prepare", "Build the envelope"],
              ["02", "Sign", "Authorize locally"],
              ["03", "Submit", "Enter the sidecar"],
              ["04", "Inspect", "Understand the result"],
            ].map(([number, title, description], i) => (
              <div className="lifecycle-item" key={number}>
                <span className="step-number">{number}</span>
                <strong>{title}</strong>
                <small>{description}</small>
                {i < 3 && <Icon name="arrow" size={14} />}
              </div>
            ))}
          </div>
        </section>

        <section className="section-block" id="first-transaction">
          <div className="section-heading">
            <h2>Your client, with frame superpowers.</h2>
            <Link href="/docs/create-client">
              Client reference <Icon name="arrow" size={14} />
            </Link>
          </div>
          <p className="section-description">
            Keep viem’s transport and public actions. Add an explicit frame
            lifecycle on top of the workshop’s existing codec.
          </p>
          <CodeBlock code={overviewCode} title="framepay.ts" />
          <div className="code-footnote">
            <Icon name="info" size={14} />
            <span>
              This excerpt assumes a configured client, prepared transaction,
              and signer.{" "}
              <Link href="/docs/quickstart">Follow the full quickstart.</Link>
            </span>
          </div>
        </section>

        <section className="section-block" id="primitives">
          <div className="section-heading">
            <h2>Small surface. Useful primitives.</h2>
          </div>
          <div className="feature-grid">
            <Link className="feature-card" href="/docs/prepare">
              <span className="feature-icon">
                <Icon name="code" />
              </span>
              <h3>
                Typed from the start <Icon name="arrow" size={15} />
              </h3>
              <p>
                Explicit frames, fees, and nonces. Clear inputs for every
                action.
              </p>
            </Link>
            <Link className="feature-card" href="/docs/receipts">
              <span className="feature-icon">
                <Icon name="layers" />
              </span>
              <h3>
                See every frame <Icon name="arrow" size={15} />
              </h3>
              <p>
                Separate a mined transaction from successfully executed frames.
              </p>
            </Link>
            <Link className="feature-card" href="/docs/admission">
              <span className="feature-icon">
                <Icon name="search" />
              </span>
              <h3>
                Know what happened <Icon name="arrow" size={15} />
              </h3>
              <p>Read admission decisions and the rules behind a rejection.</p>
            </Link>
          </div>
        </section>
        <div className="preview-notice">
          <Icon name="info" size={18} />
          <div>
            <strong>A focused developer preview</strong>
            <p>
              The current SDK targets the local ethrex workshop profile.
              Provider sponsorship quotes, PQ accounts, and pre-submission
              simulation are on the roadmap.
            </p>
          </div>
        </div>
        <Link className="next-page" href="/docs/quickstart">
          <span>
            <small>NEXT UP</small>
            <strong>Send your first frame transaction</strong>
          </span>
          <Icon name="arrow" />
        </Link>
      </article>
      <aside className="page-aside">
        <p className="aside-label">ON THIS PAGE</p>
        <a href="#workflow">Transaction lifecycle</a>
        <a href="#first-transaction">Your first transaction</a>
        <a href="#primitives">SDK primitives</a>
        <div className="aside-lab">
          <span className="lab-symbol">
            <Icon name="terminal" size={22} />
          </span>
          <span className="micro-label">A PLACE TO EXPERIMENT</span>
          <h3>
            Read it.
            <br />
            Then run it.
          </h3>
          <p>Build a real transaction against your local frame devnet.</p>
          <Link href="/playground">
            Try the playground <Icon name="arrow" size={15} />
          </Link>
          <div className="lab-grid" aria-hidden="true" />
        </div>
        <div className="aside-links">
          <span className="aside-label">RESOURCES</span>
          <a
            href="https://docs.altmempool.wtf/"
            target="_blank"
            rel="noreferrer"
          >
            Alt-mempool docs <Icon name="external" size={12} />
          </a>
          <a
            href="https://eips.ethereum.org/EIPS/eip-8141"
            target="_blank"
            rel="noreferrer"
          >
            EIP-8141 <Icon name="external" size={12} />
          </a>
        </div>
      </aside>
    </main>
  );
}
