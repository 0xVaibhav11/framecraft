"use client";
import { useState } from "react";
import { Icon } from "./icon";

function highlight(line: string) {
  if (line.trimStart().startsWith("//") || line.trimStart().startsWith("#"))
    return <span className="syntax-comment">{line}</span>;
  return line
    .split(
      /('[^']*'|"[^"]*"|\b(?:import|from|const|await|export|async|function|return|if|throw|new)\b|\b\d[\d_]*n?\b)/g
    )
    .map((part, index) => {
      const cls = /^['"]/.test(part)
        ? "syntax-string"
        : /^(import|from|const|await|export|async|function|return|if|throw|new)$/.test(
            part
          )
        ? "syntax-keyword"
        : /^\d/.test(part)
        ? "syntax-number"
        : undefined;
      return (
        <span key={index} className={cls}>
          {part}
        </span>
      );
    });
}
export function CodeBlock({
  code,
  title = "TypeScript",
  compact = false,
}: {
  code: string;
  title?: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setCopyError(false);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopyError(true);
    }
  }
  return (
    <div className={`code-block ${compact ? "compact" : ""}`}>
      <div className="code-heading">
        <span>
          <Icon name="code" size={14} />
          {title}
        </span>
        <button onClick={copy} aria-label="Copy code">
          <Icon name={copied ? "check" : "copy"} size={14} />
          {copied ? "Copied" : copyError ? "Select to copy" : "Copy"}
        </button>
      </div>
      <pre tabIndex={0}>
        <code>
          {code.split("\n").map((line, i) => (
            <span className="code-line" key={i}>
              <span className="line-number" aria-hidden="true">
                {i + 1}
              </span>
              <span>{highlight(line) || " "}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
