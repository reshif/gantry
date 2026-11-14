/**
 * A small safe Markdown renderer for assistant text. Model output is untrusted: it is parsed into React elements (never HTML),
 * raw tags stay literal text, and links are limited to http(s) and in-app hashes.
 */
import { Fragment, type ReactNode } from "react";

const SAFE_HREF = /^(https?:\/\/[^\s]+|#[^\s]*)$/i;

/** Inline: `code`, **bold**, *italic*, [text](url). */
export function inline(src: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*([^*\s][^*\n]*?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let n = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined || m[3] !== undefined) out.push(<strong key={k}>{inline((m[2] ?? m[3])!, k)}</strong>);
    else if (m[4] !== undefined) out.push(<em key={k}>{inline(m[4], k)}</em>);
    else if (SAFE_HREF.test(m[6]!)) {
      const href = m[6]!;
      out.push(<a key={k} href={href} {...(href.startsWith("#") ? {} : { target: "_blank" })} rel="noopener noreferrer">{inline(m[5]!, k)}</a>);
    } else out.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBER = /^\s{0,3}\d+[.)]\s+(.*)$/;
const FENCE = /^\s*```/;

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (FENCE.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      blocks.push(<pre key={b++} className="md-code"><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const list = BULLET.test(line) ? BULLET : NUMBER.test(line) ? NUMBER : null;
    if (list) {
      const items: string[] = [];
      while (i < lines.length && list.test(lines[i]!)) items.push(list.exec(lines[i++]!)![1]!);
      const kids = items.map((t, j) => <li key={j}>{inline(t, `l${b}-${j}`)}</li>);
      blocks.push(list === BULLET ? <ul key={b++}>{kids}</ul> : <ol key={b++}>{kids}</ol>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !FENCE.test(lines[i]!) && !BULLET.test(lines[i]!) && !NUMBER.test(lines[i]!)) para.push(lines[i++]!);
    const h = /^#{1,6}\s+(.*)$/.exec(para[0]!);
    if (h && para.length === 1) { blocks.push(<p key={b++}><strong>{inline(h[1]!, `h${b}`)}</strong></p>); continue; }
    blocks.push(<p key={b++}>{para.map((l, j) => <Fragment key={j}>{j ? <br /> : null}{inline(l, `p${b}-${j}`)}</Fragment>)}</p>);
  }
  return <>{blocks}</>;
}
