/**
 * The station document viewer (agent workspace, Phase 1, G4): every document the station agents wrote on a work order, each with its versions.
 * Rendered markdown with an outline, a version switcher, a line diff against the previous version, Copy and Download. Read-only: documents are
 * the agents' own output; people answer through questions, assumptions and the gates.
 */
import { useEffect, useMemo, useState } from "react";
import { fmt } from "@gantry/domain";
import { Btn, Empty } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { useUI } from "../../ui/overlay-context";
import { Markdown, outlineOf } from "../../ui/Markdown";
import { diffStats, lineDiff } from "../../ui/linediff";
import { useName } from "../record/bits";
import { useWoDocument, useWoDocuments, type DocVersion } from "./api";

const stationLabel = (s: string | null) => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : "Gantry");

/** Groups versions by document name, newest version last; documents ordered by when they were first written. */
function byDoc(items: DocVersion[]): Array<{ name: string; station: string | null; versions: DocVersion[] }> {
  const m = new Map<string, DocVersion[]>();
  for (const d of items) m.set(d.doc, [...(m.get(d.doc) ?? []), d]);
  return [...m.entries()].map(([name, vs]) => ({ name, station: vs[0]!.station, versions: vs.sort((a, b) => a.version - b.version) })).sort((a, b) => a.versions[0]!.createdAt - b.versions[0]!.createdAt);
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name.replace(/\//g, "-");
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Diff({ woId, from, to }: { woId: string; from: DocVersion; to: string }) {
  const a = useWoDocument(woId, from.id);
  const diff = useMemo(() => (a.data?.body !== undefined ? lineDiff(a.data.body, to) : null), [a.data?.body, to]);
  if (!diff) return <Async query={a} what="the previous version" id="doc-diff">{() => null}</Async>;
  const st = diffStats(diff);
  return (
    <div className="doc-diff" id="doc-diff">
      <p className="small muted">{`Against version ${from.version}: ${st.add} line${st.add === 1 ? "" : "s"} added, ${st.del} removed.`}</p>
      <pre className="doc-diff-body" aria-label={`Changes since version ${from.version}`}>
        {diff.map((l, i) => <div key={i} className={`doc-dl is-${l.op}`}><span className="doc-dl-op" aria-hidden="true">{l.op === "add" ? "+" : l.op === "del" ? "−" : " "}</span>{l.text || " "}</div>)}
      </pre>
    </div>
  );
}

export function DocViewer({ woId, initial }: { woId: string; initial?: string | undefined }) {
  const ui = useUI();
  const name = useName();
  const list = useWoDocuments(woId);
  const docs = useMemo(() => byDoc(list.data?.items ?? []), [list.data]);
  const [picked, setPicked] = useState<string | null>(initial ?? null);
  const [compare, setCompare] = useState(false);
  // the picked version, or the newest version of the first document
  const all = list.data?.items ?? [];
  const current = all.find((d) => d.id === picked) ?? docs[0]?.versions.at(-1) ?? null;
  const group = docs.find((g) => g.name === current?.doc);
  const prev = current && group ? group.versions.filter((v) => v.version < current.version).at(-1) ?? null : null;
  const body = useWoDocument(woId, current?.id);
  const text = body.data?.body ?? "";
  // a single top-level title is the document's name, not a section: the outline starts below it
  const outline = useMemo(() => { const o = outlineOf(text, "doc"); return o.filter((h) => h.level === 1).length === 1 ? o.filter((h) => h.level > 1) : o; }, [text]);
  useEffect(() => { if (!prev) setCompare(false); }, [prev]);

  if (!list.data) return <Async query={list} what="the documents" id="doc-viewer">{() => null}</Async>;
  if (!docs.length) return <Empty icon="page" title="No documents yet" text="Each station's agent writes its document here when its run ends." />;
  const author = (d: DocVersion) => (d.authorKind === "person" ? name(d.authorId) : d.authorId ? name(d.authorId) : stationLabel(d.station));

  return (
    <div className="doc-viewer" id="doc-viewer">
      <nav className="doc-picker" aria-label="Documents">
        {docs.map((g) => (
          <button key={g.name} type="button" className={`doc-pick${g.name === current?.doc ? " is-on" : ""}`} aria-pressed={g.name === current?.doc} id={`doc-pick-${g.name.replace(/[^a-z0-9]+/g, "-")}`} onClick={() => { setPicked(g.versions.at(-1)!.id); setCompare(false); }}>
            <span className="doc-pick-name mono">{g.name}</span>
            <span className="doc-pick-meta small muted">{`${stationLabel(g.station)} · v${g.versions.at(-1)!.version}`}</span>
          </button>
        ))}
      </nav>
      {current ? (
        <article className="doc-main" aria-label={current.doc}>
          <header className="doc-head">
            <div className="doc-head-t">
              <h3 className="doc-title mono">{current.doc}</h3>
              <p className="small muted doc-byline">{`Version ${current.version} · written by ${author(current)} at ${stationLabel(current.station)} · ${fmt.stamp(current.createdAt)}`}</p>
            </div>
            <div className="doc-tools">
              {group && group.versions.length > 1 ? (
                <label className="doc-ver small">
                  <span className="muted">Version</span>
                  <select className="input" id="doc-version" value={current.id} onChange={(e) => setPicked(e.target.value)}>
                    {group.versions.slice().reverse().map((v) => <option key={v.id} value={v.id}>{`v${v.version} · ${fmt.stamp(v.createdAt)}`}</option>)}
                  </select>
                </label>
              ) : null}
              {prev ? <Btn small id="doc-compare" label={compare ? "Show document" : `Compare with v${prev.version}`} onClick={() => setCompare(!compare)} /> : null}
              <Btn small icon="copy" id="doc-copy" label="Copy" disabled={!text} onClick={async () => { try { await navigator.clipboard.writeText(text); ui.toast("Copied as Markdown.", "ok"); } catch { ui.toast("The browser did not allow copying.", "error"); } }} />
              <Btn small icon="down" id="doc-download" label="Download" disabled={!text} onClick={() => download(current.doc, text)} />
            </div>
          </header>
          <div className="doc-body-grid">
            {outline.length > 1 && !compare ? (
              <nav className="doc-outline small" aria-label="On this page">
                <p className="kicker">On this page</p>
                <ul>{outline.map((h) => <li key={h.id} className={`lv-${Math.min(h.level, 4)}`}><a href={`#${h.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(h.id)?.scrollIntoView?.({ block: "start" }); }}>{h.text}</a></li>)}</ul>
              </nav>
            ) : null}
            <div className="doc-body">
              {body.data ? (compare && prev ? <Diff woId={woId} from={prev} to={text} /> : <div className="md-doc"><Markdown text={text} idPrefix="doc" /></div>) : <Async query={body} what="the document" id="doc-body">{() => null}</Async>}
            </div>
          </div>
          <p className="small muted doc-foot">{`Agent-written. Stored with its hash ${current.contentHash.slice(0, 12)}; secrets are redacted before it is saved.`}</p>
        </article>
      ) : null}
    </div>
  );
}
