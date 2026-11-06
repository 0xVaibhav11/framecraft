import Link from "next/link";
export default function NotFound() {
  return (
    <main className="article not-found" id="main-content">
      <div className="eyebrow">404 · DOCUMENT NOT FOUND</div>
      <h1>That page isn’t here.</h1>
      <p>Explore the SDK reference or start with the quickstart.</p>
      <Link className="button primary" href="/">
        Back to the docs →
      </Link>
    </main>
  );
}
