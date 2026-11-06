"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BrandMark, Icon, type IconName } from "./icon";
import { NetworkBadge, NetworkProvider } from "./network";
import { searchEntries } from "@/lib/docs";

const groups: {
  label: string;
  items: { label: string; href: string; icon?: IconName; badge?: string }[];
}[] = [
  {
    label: "GET STARTED",
    items: [
      { label: "Overview", href: "/", icon: "book" },
      { label: "Quickstart", href: "/docs/quickstart", icon: "bolt" },
      { label: "Create a client", href: "/docs/create-client", icon: "code" },
    ],
  },
  {
    label: "SDK REFERENCE",
    items: [
      { label: "Compose a transfer", href: "/docs/compose-transfer" },
      { label: "Prepare a transaction", href: "/docs/prepare" },
      { label: "Sign locally", href: "/docs/sign" },
      { label: "Submit to the sidecar", href: "/docs/submit" },
      { label: "Read frame receipts", href: "/docs/receipts" },
      { label: "Inspect admission", href: "/docs/admission" },
    ],
  },
  {
    label: "BUILD & EXPLORE",
    items: [
      { label: "DeFi app", href: "/app", icon: "wallet", badge: "NEW" },
      {
        label: "Playground",
        href: "/playground",
        icon: "terminal",
        badge: "LIVE",
      },
    ],
  },
];
function Search() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        dialog.current?.showModal();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const entries = searchEntries.filter((item) =>
    `${item.title} ${item.description}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );
  return (
    <>
      <button
        className="search-trigger"
        onClick={() => dialog.current?.showModal()}
      >
        <Icon name="search" size={16} />
        <span>Search documentation</span>
        <kbd>⌘ K</kbd>
      </button>
      <dialog
        ref={dialog}
        className="search-dialog"
        aria-label="Search documentation"
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current?.close();
        }}
      >
        <div className="search-input-row">
          <Icon name="search" />
          <input
            aria-label="Search documentation"
            placeholder="Find an action, guide, or example…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <button
            className="icon-button"
            aria-label="Close search"
            onClick={() => dialog.current?.close()}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="search-results">
          {entries.length ? (
            entries.map((entry) => (
              <Link
                key={entry.href}
                href={entry.href}
                onClick={() => dialog.current?.close()}
              >
                <Icon
                  name={entry.href === "/playground" ? "terminal" : "book"}
                />
                <span>
                  <strong>{entry.title}</strong>
                  <small>{entry.description}</small>
                </span>
                <Icon name="arrow" size={16} />
              </Link>
            ))
          ) : (
            <p className="search-empty">
              No results for “{query}”. Try “prepare” or “receipt”.
            </p>
          )}
        </div>
        <div className="search-footer">
          Search FramePay documentation <kbd>esc to close</kbd>
        </div>
      </dialog>
    </>
  );
}
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const active = searchEntries.find((item) => item.href === pathname);
  useEffect(() => setMobileOpen(false), [pathname]);
  if (pathname === "/app") return <NetworkProvider>{children}</NetworkProvider>;
  return (
    <NetworkProvider>
      <div className="workspace">
        {mobileOpen && (
          <button
            className="sidebar-backdrop"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          />
        )}
        <aside className={`sidebar ${mobileOpen ? "open" : ""}`}>
          <Link href="/" className="brand">
            <BrandMark />
            <span>
              framepay<span className="brand-sdk">SDK</span>
            </span>
          </Link>
          <div className="version-label">
            <span className="tiny-dot" />
            Developer preview<span>v0.0.0</span>
          </div>
          <nav aria-label="Documentation navigation">
            {groups.map((group) => (
              <div className="nav-group" key={group.label}>
                <p>{group.label}</p>
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={pathname === item.href ? "page" : undefined}
                    className={`nav-item ${
                      pathname === item.href ? "active" : ""
                    } ${item.icon ? "" : "nested"}`}
                  >
                    {item.icon ? (
                      <Icon name={item.icon} size={17} />
                    ) : (
                      <span className="nav-tick" />
                    )}
                    <span>{item.label}</span>
                    {item.badge && (
                      <span className="nav-badge">{item.badge}</span>
                    )}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-note">
              <Icon name="layers" size={19} />
              <strong>Native by design.</strong>
              <p>Built for EIP-8141 frame transactions.</p>
              <a
                href="https://eips.ethereum.org/EIPS/eip-8141"
                target="_blank"
                rel="noreferrer"
              >
                Read the proposal <Icon name="external" size={12} />
              </a>
            </div>
            <a
              className="source-link"
              href="https://github.com/Trymbakmahant/framepay-sdk"
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="github" size={16} />
              View source
              <Icon name="external" size={13} />
            </a>
          </div>
        </aside>
        <div className="workspace-main">
          <header className="topbar">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <div className="breadcrumbs">
              <span>Developers</span>
              <Icon name="chevron" size={12} />
              <strong>{active?.title ?? "Documentation"}</strong>
            </div>
            <div className="topbar-tools">
              <Search />
              <span className="topbar-divider" />
              <NetworkBadge />
            </div>
          </header>
          {children}
          <footer className="site-footer">
            <span>
              <span className="tiny-dot" /> FramePay SDK · Experimental EIP-8141
              tooling
            </span>
            <a
              href="https://github.com/Trymbakmahant/framepay-sdk"
              target="_blank"
              rel="noreferrer"
            >
              Built in the open <Icon name="external" size={12} />
            </a>
          </footer>
        </div>
      </div>
    </NetworkProvider>
  );
}
