/**
 * Changes (#changes/WO-x): the files, diff previews and commits of one work order, with its plan and the Builder's guardrail.
 * The content is the same Changes section the work order page shows; this page gives it the whole width.
 */
import { WoActions } from "./work/WoActions";
import { navigate, useHash } from "../lib/router";
import { Btn, Chip, Empty, Panel, Stat, StatRow, ViewHead } from "../ui/primitives";
import { hashFor } from "../lib/router";
import { useMemo } from "react";
import { useActors } from "../ui/actors";
import { splitQuery, useHashQuery } from "./dossier/hashQuery";
import { Loading } from "../ui/async";
import { ChangesIndex } from "./changes/Index";
import { FileDiff, whyNoDiff } from "./changes/Diff";
import { useWoDiff, type DiffFile } from "../api/queries";
import { useChangesRead, useRecordData, sum, type RecFile } from "./record/data";
import "../styles/views/dossier.css";

export default function ChangesView() {
  const hash = useHash();
  const id = splitQuery(hash.param).id.toUpperCase();
  const d = useRecordData(id || null);
  const ch = useChangesRead(id || null).data;
  const [fileQ, setFile] = useHashQuery("file");
  const actor = useActors();
  const diffQ = useWoDiff(id || null);
  const diff = diffQ.data;
  /** One row per file. The diff read has one entry per path across all commits (the record lists a path once per commit); files only the plan or the record knows are kept, with the reason they have no lines. */
  const files: Array<RecFile & { df?: DiffFile }> = useMemo(() => {
    if (!d.wo || !d.rec) return [];
    const planFiles = (d.wo.files ?? []) as RecFile[];
    const byPath = new Map(planFiles.map((f) => [f.path, f]));
    const out: Array<RecFile & { df?: DiffFile }> = [];
    const put = (f: RecFile, df?: DiffFile) => { if (!out.some((x) => x.path === f.path)) out.push({ ...(byPath.get(f.path) ?? {}), ...f, ...(df ? { df } : {}) }); };
    for (const f of diff?.files ?? []) put({ path: f.path, status: f.status, plus: f.plus, minus: f.minus }, f);
    const recorded = ch?.files ?? d.rec.code?.files ?? [];
    // the record lists a path once per commit; fold repeats so a file is one row
    for (const f of recorded) { if (!out.some((x) => x.path === f.path)) put(recorded.filter((x) => x.path === f.path).reduce((a, x) => ({ ...a, plus: a.plus + x.plus, minus: a.minus + x.minus }), { ...f, plus: 0, minus: 0 })); }
    for (const f of planFiles) put(f);
    return out;
  }, [ch, diff, d.wo, d.rec]);
  if (!id) return <ChangesIndex />;
  if (d.loading) return <div className="view rec-view"><Loading id="chg-loading" label="the changes" /></div>;
  if (d.error || !d.wo || !d.rec || !d.project || !d.cat) {
    const status = (d.error as { status?: number } | null)?.status;
    const missing = status === 403 || status === 404 || !d.error;
    return (
      <div className="view rec-view" id="chg-missing">
        <ViewHead plain title="Changes" />
        <Panel>
          <Empty title="Nothing to show" text={missing ? "That work order does not exist." : `Could not load the changes of ${id}.`} action={<Btn label="Work orders" id="chg-missing-wos" onClick={() => navigate("work-orders")} />} />
        </Panel>
      </div>
    );
  }
  const { wo, rec } = d;
  const sel = files.find((f) => f.path === fileQ) ?? files[0];
  const commits = ch?.commits ?? (rec.code?.commits ?? []).map((x) => ({ sha: x.sha, message: x.message, author: x.author }));
  const pr = rec.code?.pullRequests?.[0] ?? null;
  const waitingGate = Object.entries(wo.gates ?? {}).find(([, g]) => g.status === "waiting")?.[0];
  return (
    <div className="view rec-view dz">
      <ViewHead
        plain
        kicker={<span style={{ display: "inline-flex", gap: 8 }}><a href={hashFor("changes", null, wo.project)} onClick={(e) => { e.preventDefault(); navigate("changes", null, wo.project); }}>Changes</a><span aria-hidden="true">/</span><a href={hashFor("record", wo.id, wo.project)} onClick={(e) => { e.preventDefault(); navigate("record", wo.id, wo.project); }}>{wo.id}</a></span>}
        title={`Changes · ${wo.id}`}
        sub={wo.title}
        actions={<><WoActions wo={wo.id} project={wo.project} repo={wo.repo} idPrefix="chg" small={false} /><Btn label={waitingGate ? `Review ${d.cat.gates.find((g) => g.id === waitingGate)?.label ?? waitingGate}` : "Review gates"} icon="branch" id="chg-review" onClick={() => { window.location.hash = `${hashFor("record", wo.id, wo.project)}?tab=gates`; }} /></>}
      />
      <StatRow id="chg-stats">
        <Stat label="Files" value={String(files.length)} />
        <Stat label="Added" value={`+${sum(files, "plus")}`} tone="done" sub={files.some((f) => f.df?.approximate) ? "approximate" : undefined} />
        <Stat label="Removed" value={`−${sum(files, "minus")}`} tone="block" sub={files.some((f) => f.df?.approximate) ? "approximate" : undefined} />
        <Stat label="Tests passed" value={String(rec.code.tests.passed)} sub={`${rec.code.tests.added} added`} tone="info" />
        <Stat label="PR" value={pr ? `#${pr.number}` : "—"} sub={pr ? `${pr.state} · ${wo.pr ? wo.pr.checks : "no checks"}` : "none"} />
      </StatRow>
      <div className="cols w12">
        <Panel title="Files" flush>
          {files.length ? (
            <ul className="list" id="chg-files">
              {files.map((f) => (
                <li key={f.path} style={f.path === sel?.path ? { background: "var(--accent-soft)" } : undefined}>
                  <a className="pri trunc grow mono small" href={`${hashFor("changes", wo.id, wo.project)}?file=${encodeURIComponent(f.path)}`} aria-current={f.path === sel?.path ? "true" : undefined} title={f.path} onClick={(e) => { e.preventDefault(); setFile(f.path); }}>{f.path}</a>
                  <Chip text={f.status} cls={f.status === "added" ? "ok" : "plain"} />
                  {f.df?.approximate ? <Chip text="approx." cls="warn" /> : null}
                  <span className="num small">{`${f.df?.approximate ? "≈ " : ""}+${f.plus}/−${f.minus}`}</span>
                </li>
              ))}
            </ul>
          ) : <Empty title="No files yet" text="The Build station has not changed anything." />}
        </Panel>
        <div className="stack">
          <Panel title={sel ? sel.path : "Diff"} flush tools={sel ? <><Chip text={sel.protected ? "protected path" : "normal path"} cls={sel.protected ? "warn" : "plain"} />{sel.step ? <Chip text={sel.step} cls="plain" /> : null}</> : undefined}>
            {sel?.df && diff ? (
              <FileDiff file={sel.df} diff={diff} commitMessage={(sha) => commits.find((c) => c.sha === sha)?.message ?? ""} />
            ) : sel?.preview?.length ? (
              <div className="diff pre" id="chg-diff" style={{ padding: 0 }}>
                {sel.preview.map((l, i) => <div key={i} className={l.t === "+" ? "a" : l.t === "-" ? "d" : undefined}>{`${l.t} ${l.s}`}</div>)}
              </div>
            ) : sel ? (
              <div className="empty" id="chg-nodiff">{diffQ.isPending ? "Loading the diff…" : whyNoDiff(diff, diffQ.isError)}</div>
            ) : <div className="empty">Select a file.</div>}
          </Panel>
          <Panel title="Commits and checks" flush>
            <div className="stack">
              {commits.length ? (
                <ul className="list">
                  {commits.map((c) => (
                    <li key={c.sha}><span className="mono small">{c.sha.slice(0, 7)}</span><span className="grow">{c.message}</span><span className="small muted">{c.author ? actor(c.author).name : ""}</span></li>
                  ))}
                </ul>
              ) : <div className="empty">No commits.</div>}
              {wo.checks?.length ? <div className="row" style={{ padding: "0 12px 12px" }}>{wo.checks.map((c) => <Chip key={c.name} text={`${c.name} ${c.status}`} cls={c.status === "passed" ? "ok" : "bad"} />)}</div> : null}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
