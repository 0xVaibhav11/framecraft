import { notFound } from "next/navigation";
import Link from "next/link";
import { docs } from "@/lib/docs";
import { CodeBlock } from "@/components/code-block";
import { Icon } from "@/components/icon";

export function generateStaticParams() {
  return docs.map(({ slug }) => ({ slug }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return {
    title: docs.find((doc) => doc.slug === slug)?.title ?? "Documentation",
  };
}
export default async function ReferencePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const index = docs.findIndex((doc) => doc.slug === slug);
  if (index < 0) notFound();
  const doc = docs[index];
  const next = docs[index + 1];
  return (
    <main id="main-content" className="docs-layout">
      <article className="article">
        <div className="eyebrow">{doc.category.toUpperCase()}</div>
        <h1 className="doc-title">{doc.title}</h1>
        <p className="hero-description">{doc.description}</p>
        <div className="signature">
          <span>API</span>
          <code>{doc.signature}</code>
        </div>
        <section className="section-block" id="usage">
          <div className="section-heading">
            <h2>Usage</h2>
            <span className="micro-label">TYPESCRIPT</span>
          </div>
          <CodeBlock title={`${doc.slug}.ts`} code={doc.code} />
          <p className="code-footnote">
            <Icon name="info" size={14} />
            Examples use the configured client from{" "}
            <Link href="/docs/create-client">Create a client</Link>.
          </p>
        </section>
        <section className="section-block" id="parameters">
          <h2>Parameters</h2>
          <div className="parameter-table">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {doc.parameters.map((param) => (
                  <tr key={param.name}>
                    <td>
                      <code>{param.name}</code>
                    </td>
                    <td>
                      <code>{param.type}</code>
                    </td>
                    <td>{param.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="section-block" id="returns">
          <h2>Returns</h2>
          <div className="return-value">
            <Icon name="arrow" size={16} />
            <p>{doc.returns}</p>
          </div>
        </section>
        <section className="section-block" id="behavior">
          <h2>Behavior to know</h2>
          <ul className="behavior-list">
            {doc.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
        <Link
          className="next-page"
          href={next ? `/docs/${next.slug}` : "/playground"}
        >
          <span>
            <small>NEXT UP</small>
            <strong>{next?.title ?? "Try the playground"}</strong>
          </span>
          <Icon name="arrow" />
        </Link>
      </article>
      <aside className="page-aside">
        <p className="aside-label">ON THIS PAGE</p>
        <a href="#usage">Usage</a>
        <a href="#parameters">Parameters</a>
        <a href="#returns">Returns</a>
        <a href="#behavior">Behavior to know</a>
        <Link className="aside-playground" href="/playground">
          <Icon name="terminal" />
          Try it live <Icon name="arrow" size={14} />
        </Link>
      </aside>
    </main>
  );
}
