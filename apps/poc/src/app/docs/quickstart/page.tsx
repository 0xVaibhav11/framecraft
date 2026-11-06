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
            code={"npm run sdk:bootstrap\nnpm test"}
          />
          <p>
            The app defaults to the configured Cloudflare gateway on chain <code>1337</code>.
            Local Docker is not required. Network identity includes the genesis hash.
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
            <span className="inline-number">03</span>Open the DeFi app
          </h2>
          <p>
            Build the ETHFalcon browser signer using Emscripten 3.1.74,
            then start the app. The configured devnet already has public
            deployment records for the wallet factory, paymaster and Aqua market.
          </p>
          <CodeBlock title="Terminal" code={"npm run aqua:bootstrap\nnpm run quantum:build\nnpm run poc:bootstrap\nnpm run poc:dev"} />
          <p>
            Open <Link href="/app">the app</Link>, create a quantum wallet,
            deploy it, claim test tokens and review a swap or transfer.
            Each submitted action checks its receipt and every frame result.
          </p>
        </section>
        <section className="section-block" id="browser">
          <h2>
            <span className="inline-number">04</span>Try the browser playground
          </h2>
          <p>
            Select Framecraft devnet or Public alt-mempool devnet in the top bar.
            Both use chain ID 1337 but have separate histories, accounts and
            deployments. Neither selection requires local Docker.
          </p>
          <p>
            Create a disposable account in this tab, fund it using the devnet
            faucet, and walk through the SDK one action at a time. Choose
            self-payment or request a deployed paymaster, set draft limits, then
            review the generated frames before signing. The account uses
            SECP256K1 authorization.
          </p>
          <Link className="button primary" href="/playground">
            Open playground <Icon name="arrow" size={16} />
          </Link>
        </section>
        <section className="section-block" id="paymaster">
          <h2>
            <span className="inline-number">05</span>Deploy a test paymaster
          </h2>
          <p>
            From the FramePay directory, deploy the included artifact to the
            selected network. The script creates a separate deployment key,
            requests faucet funding, and funds the paymaster with 0.01 test ETH.
          </p>
          <CodeBlock
            title="Terminal · choose a network"
            code={
              "npm run paymaster:deploy -- --network devnet\n# Or use the separate public alt-mempool devnet:\nnpm run paymaster:deploy -- --network public"
            }
          />
          <p>
            After a successful deployment, the script records its receipt, code
            hash and genesis in <code>config/paymasters.json</code>. The
            playground then offers “Use deployed FramePay paymaster” for that
            network. Run the dev server or rebuild a production frontend after
            updating this file.
          </p>
          <p>
            This is an open test sponsor: anyone can consume its finite budget,
            subject to a 0.001 ETH maximum transaction cost. It does not provide
            allowlisted sponsorship, token reimbursement or automatic refills.
            Its policy depends on the ethrex profile’s MAX_COST extension.
          </p>
          <p>
            If a deployment response is lost, rerun the same command to inspect
            the saved transaction hash. The script does not automatically send a
            second deployment. A chain reset or source change requires reviewing
            the old record before a new deployment.
          </p>
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
        <a href="#paymaster">Deploy a paymaster</a>
      </aside>
    </main>
  );
}
