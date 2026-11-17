/**
 * The one way to link to another origin. Only http(s) URLs become links (a `javascript:` or `data:` href renders as plain text),
 * the link opens in a new tab with `noopener noreferrer nofollow`, carries a visual cue and a spoken "opens in a new tab",
 * and can show the destination host so a long or disguised label cannot hide where it goes.
 */
import type { ReactNode } from "react";

/** The parsed URL when `href` is an absolute http(s) URL, else null. */
export function safeExternalUrl(href: string | null | undefined): URL | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

export function ExtLink({ href, children, showHost, className, id }: { href: string | null | undefined; children?: ReactNode; /** Append the host in parentheses after the label. */ showHost?: boolean; className?: string; id?: string }) {
  const url = safeExternalUrl(href);
  const label = children ?? href ?? "";
  if (!url) return <span className={className}>{label}</span>;
  return (
    <a id={id} className={`ext-link${className ? ` ${className}` : ""}`} href={url.href} target="_blank" rel="noopener noreferrer nofollow">
      {label}
      {showHost ? <span className="ext-host"> ({url.host})</span> : null}
      <svg className="ext-ic" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
        <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9 2h5v5M14 2 7.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
