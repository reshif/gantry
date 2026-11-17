/**
 * The one Markdown renderer (agent workspace, G14): agent answers, station documents, previews. Agent text is untrusted, so it is parsed into
 * React elements and never into HTML: raw tags stay literal text, and links go only to http(s) or in-page anchors.
 *
 * A GitHub-flavoured subset: headings (with anchors for an outline), paragraphs, bullet, numbered and task lists (one level of nesting), fenced
 * code, block quotes, tables with a header row, horizontal rules, and inline code, bold, italic, strike-through and links.
 */
import { ExtLink } from "./ExtLink";
import { docHeadings } from "@gantry/domain";
import { createContext, Fragment, useContext, type ReactNode } from "react";

/** Where a citation `[^s3]` goes: the document viewer provides it to open the source; without it a citation is a plain marker. */
export const CiteContext = createContext<((ref: string) => void) | null>(null);
function Cite({ refId }: { refId: string }) {
  const open = useContext(CiteContext);
  return open ? <button type="button" className="md-cite" aria-label={`Source ${refId}`} onClick={() => open(refId)}>{refId}</button> : <sup className="md-cite is-static">{refId}</sup>;
}

const SAFE_HREF = /^(https?:\/\/[^\s]+|#[^\s]*)$/i;

/** Inline: `code`, **bold**, *italic*, ~~strike~~, [text](url), citations [^s3]. */
export function inline(src: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*([^*\s][^*\n]*?)\*|~~([^~\n]+?)~~|\[\^(s\d{1,6})\]|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let n = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined || m[3] !== undefined) out.push(<strong key={k}>{inline((m[2] ?? m[3])!, k)}</strong>);
    else if (m[4] !== undefined) out.push(<em key={k}>{inline(m[4], k)}</em>);
    else if (m[5] !== undefined) out.push(<s key={k}>{inline(m[5], k)}</s>);
    else if (m[6] !== undefined) out.push(<Cite key={k} refId={m[6]} />);
    else if (SAFE_HREF.test(m[8]!)) {
      const href = m[8]!;
      out.push(href.startsWith("#") ? <a key={k} href={href}>{inline(m[7]!, k)}</a> : <ExtLink key={k} href={href}>{inline(m[7]!, k)}</ExtLink>);
    } else out.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBER = /^(\s*)\d+[.)]\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

/** A stable anchor for a heading: lower-case words joined by dashes. */
export const slug = (t: string): string => t.toLowerCase().replace(/[`*_~[\]()]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";

export interface OutlineItem { level: number; text: string; id: string }

/** The document's headings, outside code fences, with the same ids the renderer gives them. */
export function outlineOf(text: string, idPrefix = "md"): OutlineItem[] {
  const seen = new Map<string, number>();
  return docHeadings(text).map((h) => {
    const base = slug(h.text);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { level: h.level, text: h.text, id: `${idPrefix}-${base}${n > 1 ? `-${n}` : ""}` };
  });
}

const cells = (row: string): string[] => row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

function listItem(t: string, k: string): ReactNode {
  const task = TASK.exec(t);
  if (!task) return inline(t, k);
  return <><span className={`md-task${task[1] !== " " ? " is-done" : ""}`} aria-label={task[1] !== " " ? "done" : "not done"}>{task[1] !== " " ? "☑" : "☐"}</span> {inline(task[2]!, k)}</>;
}

/**
 * Renders `text`. `idPrefix` makes heading anchors unique on the page (two documents side by side); `headings: false` renders headings as bold
 * paragraphs, for chat answers where a heading would shout.
 */
export function Markdown({ text, idPrefix = "md", headings = true }: { text: string; idPrefix?: string; headings?: boolean }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  const seen = new Map<string, number>();
  let i = 0;
  let b = 0;
  const startsBlock = (l: string, next: string | undefined) => FENCE.test(l) || BULLET.test(l) || NUMBER.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || (l.includes("|") && next !== undefined && TABLE_SEP.test(next));
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
    const h = HEADING.exec(line);
    if (h) {
      i++;
      const t = h[2]!;
      if (!headings) { blocks.push(<p key={b++}><strong>{inline(t, `h${b}`)}</strong></p>); continue; }
      const base = slug(t.replace(/[`*_~]/g, ""));
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const Tag = (`h${Math.min(6, h[1]!.length + 1)}`) as "h2";
      blocks.push(<Tag key={b++} id={`${idPrefix}-${base}${n > 1 ? `-${n}` : ""}`} className={`md-h md-h${h[1]!.length}`}>{inline(t, `h${b}`)}</Tag>);
      continue;
    }
    if (RULE.test(line)) { i++; blocks.push(<hr key={b++} className="md-rule" />); continue; }
    if (QUOTE.test(line)) {
      const q: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) q.push(QUOTE.exec(lines[i++]!)![1]!);
      blocks.push(<blockquote key={b++} className="md-quote"><Markdown text={q.join("\n")} idPrefix={`${idPrefix}-q${b}`} headings={false} /></blockquote>);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      blocks.push(
        <div key={b++} className="md-table-wrap">
          <table className="md-table">
            <thead><tr>{head.map((c, j) => <th key={j} scope="col">{inline(c, `t${b}h${j}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? "", `t${b}r${ri}c${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    const list = BULLET.test(line) ? BULLET : NUMBER.test(line) ? NUMBER : null;
    if (list) {
      const items: Array<{ text: string; nested: string[] }> = [];
      const indent0 = list.exec(line)![1]!.length;
      while (i < lines.length) {
        const l = lines[i]!;
        const m = BULLET.exec(l) ?? NUMBER.exec(l);
        if (m && m[1]!.length <= indent0) { if (!list.test(l)) break; items.push({ text: m[2]!, nested: [] }); i++; continue; }
        if (m && items.length) { items.at(-1)!.nested.push(m[2]!); i++; continue; }
        // a wrapped continuation line of the item above
        if (l.trim() && /^\s{2,}\S/.test(l) && items.length) { items.at(-1)!.text += ` ${l.trim()}`; i++; continue; }
        break;
      }
      const kids = items.map((it, j) => (
        <li key={j}>
          {listItem(it.text, `l${b}-${j}`)}
          {it.nested.length ? <ul>{it.nested.map((t, k) => <li key={k}>{listItem(t, `l${b}-${j}-${k}`)}</li>)}</ul> : null}
        </li>
      ));
      blocks.push(list === BULLET ? <ul key={b++}>{kids}</ul> : <ol key={b++}>{kids}</ol>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && (para.length === 0 || !startsBlock(lines[i]!, lines[i + 1]))) para.push(lines[i++]!);
    blocks.push(<p key={b++}>{para.map((l, j) => <Fragment key={j}>{j ? <br /> : null}{inline(l, `p${b}-${j}`)}</Fragment>)}</p>);
  }
  return <>{blocks}</>;
}
