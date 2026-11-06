import type { CSSProperties } from "react";
export type IconName =
  | "arrow"
  | "external"
  | "code"
  | "layers"
  | "terminal"
  | "book"
  | "search"
  | "copy"
  | "check"
  | "chevron"
  | "github"
  | "menu"
  | "close"
  | "bolt"
  | "refresh"
  | "key"
  | "wallet"
  | "download"
  | "circle"
  | "info";
const paths: Record<IconName, React.ReactNode> = {
  arrow: (
    <>
      <path d="M4 12h15m-6-6 6 6-6 6" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6m0-6-10 10M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" />
    </>
  ),
  code: (
    <>
      <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 10 5-10 5L2 8l10-5Zm-9 10 9 5 9-5M3 18l9 5 9-5" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </>
  ),
  book: (
    <>
      <path d="M4 3h13a2 2 0 0 1 2 2v16H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3m-3 15a3 3 0 0 1 3-3h13M8 7h7m-7 4h5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  github: (
    <>
      <path d="M9 19c-4 1-4-2-6-2m12 5v-4a3 3 0 0 0-.8-2.3c2.7-.3 5.6-1.3 5.6-6A4.7 4.7 0 0 0 18.5 6a4.4 4.4 0 0 0-.1-3.5S17.3 2.2 15 3.8a13.4 13.4 0 0 0-6 0C6.7 2.2 5.6 2.5 5.6 2.5A4.4 4.4 0 0 0 5.5 6a4.7 4.7 0 0 0-1.3 3.7c0 4.7 2.9 5.7 5.6 6A3 3 0 0 0 9 18v4" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z" />,
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M5 8a7 7 0 0 1 12-3l3 4M4 15l3 4a7 7 0 0 0 12-3" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="m12 12 9 9m-5-5 3-3m0 6 3-3" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="5" width="18" height="15" rx="3" />
      <path d="M3 8V5l13-3v3m5 6h-6v5h6" />
      <path d="M17 13.5h.01" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4" />
    </>
  ),
  circle: <circle cx="12" cy="12" r="8" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v.5" />
    </>
  ),
};
export function Icon({
  name,
  size = 18,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
export function BrandMark() {
  return (
    <svg
      width="31"
      height="31"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="9" fill="#116952" />
      <path d="M9 10h15l-3 4H9v-4Zm0 7h11l-3 4h-4v4H9v-8Z" fill="#e8faf0" />
    </svg>
  );
}
