/**
 * The station document viewer (agent workspace, Phase 1, G4): every document the station agents wrote on a work order, each with its versions.
 * Rendered markdown with an outline, a version switcher, a line diff against the previous version, Copy and Download. Documents are the agents' own
 * output; people steer through questions, assumptions and the gates, and also comment on a section, edit the newest version (saved as a new version in
 * their name) and accept a version as the station's output (DocComments.tsx).
 */
import { useEffect, useMemo, useState } from "react";
import { fmt } from "@gantry/domain";
import { Btn, Empty, type Decision } from "../../ui/primitives";
import { useCommand } from "../../ui/async";
import { Async } from "../../ui/async";
import { useUI } from "../../ui/overlay-context";
import { CiteContext, Markdown, outlineOf } from "../../ui/Markdown";
import { SourceDetail, SourceList } from "./Research";
import { diffStats, lineDiff } from "../../ui/linediff";
import { useName } from "../record/bits";
import { useCan } from "../../api/can";
import { DocComments, DocEditor } from "./DocComments";
import { acceptDocument, useWoDocComments, useWoDocument, useWoDocuments, useWoSources, type DocVersion } from "./api";

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

export function DocViewer({ woId, initial, project }: { woId: string; initial?: string | undefined; project?: string | undefined }) {
  const ui = useUI();
  const name = useName();
  const list = useWoDocuments(woId);
  const docs = useMemo(() => byDoc(list.data?.items ?? []), [list.data]);
  const [picked, setPicked] = useState<string | null>(initial ?? null);
  const [compare, setCompare] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [editing, setEditing] = useState(false);
  const mayApprove = useCan("gate.approve", project ? { project } : {});
  // with no project to ask about, the server decides when the button is pressed
  const guard: Decision | null = project ? { allowed: mayApprove.allowed, reason: mayApprove.reason, needs: mayApprove.needs } : null;
  const comments = useWoDocComments(woId).data?.items ?? [];
  const sources = useWoSources(woId).data?.items ?? [];
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
  useEffect(() => { setEditing(false); }, [current?.id]);
  const accept = useCommand((id: string) => acceptDocument(woId, id));
  const isNewest = !!current && group?.versions.at(-1)?.id === current.id;
  const sections = useMemo(() => [...new Set(outline.map((h) => h.text))], [outline]);

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
              <p className="small muted doc-byline">{`Version ${current.version} · ${current.authorKind === "system" ? `recorded by Gantry at ${stationLabel(current.station)}` : `${current.authorKind === "person" ? "edited by" : "written by"} ${author(current)}${current.authorKind === "person" ? "" : ` at ${stationLabel(current.station)}`}`} · ${fmt.stamp(current.createdAt)}${current.acceptedBy ? ` · accepted as station output by ${name(current.acceptedBy)}` : ""}`}</p>
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
              {sources.length ? <Btn small id="doc-sources" label={showSources ? "Hide sources" : `Sources (${sources.length})`} onClick={() => { setShowSources(!showSources); setSource(null); }} /> : null}
              {!current.acceptedBy ? <Btn small kind="primary" id="doc-accept" label="Accept as station output" guard={guard} disabledReason={accept.wait()} onClick={() => void accept.run(current.id)} /> : null}
              {isNewest && !editing ? <Btn small id="doc-edit" label="Edit" guard={guard} disabled={!text} onClick={() => { setEditing(true); setCompare(false); }} /> : null}
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
              {source ? <SourceDetail woId={woId} refId={source} onClose={() => setSource(null)} /> : showSources ? <section className="src-panel" aria-label="Sources"><SourceList items={sources} pick={(r) => setSource(r)} /></section> : null}
              {editing && body.data ? <DocEditor woId={woId} version={current} text={text} onDone={(id) => { setEditing(false); if (id) setPicked(id); }} /> : body.data ? (compare && prev ? <Diff woId={woId} from={prev} to={text} /> : <CiteContext.Provider value={(r) => { setSource(r); setShowSources(false); }}><div className="md-doc"><Markdown text={text} idPrefix="doc" /></div></CiteContext.Provider>) : <Async query={body} what="the document" id="doc-body">{() => null}</Async>}
            </div>
          </div>
          <DocComments woId={woId} version={current} sections={sections} items={comments.filter((c) => c.doc === current.doc)} />
          <p className="small muted doc-foot">{`${current.authorKind === "person" ? "Edited by a person" : current.authorKind === "system" ? "Recorded by Gantry from what the station did, not written by an agent" : "Agent-written"}. Stored with its hash ${current.contentHash.slice(0, 12)}${current.authorKind === "person" ? "." : "; secrets are redacted before it is saved."}`}</p>
        </article>
      ) : null}
    </div>
  );
}
