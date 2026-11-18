/**
 * Changes (#changes/WO-x): the prototype's two-column review (files on the left, the selected file's diff on the right), with the
 * plan, commits and the Builder's guardrail kept in the full Changes section below it.
 */
import { useMemo } from "react";
import { hashFor, navigate, useHash } from "../lib/router";
import { ReviewBtn } from "./dossier/Head";
import { Page, Card } from "../ui/cr";
import { Loading } from "../ui/async";
import { Picker } from "./record/Picker";
import { Changes } from "./record/sections2";
import { useChangesRead, useRecordData, sum, type RecFile } from "./record/data";
import { Empty } from "../ui/primitives";

const split = (p: string): { name: string; dir: string } => {
  const i = p.lastIndexOf("/");
  return { name: p.slice(i + 1), dir: i < 0 ? "" : p.slice(0, i) };
};

export default function ChangesView() {
  const hash = useHash();
  const [rawId = "", rawFile = ""] = (hash.param || "").split("/");
  const id = rawId.toUpperCase();
  const d = useRecordData(id || null);
  const ch = useChangesRead(id || null).data;
  const files: RecFile[] = useMemo(() => {
    if (!d.rec || !d.wo) return [];
    const plan = ((d.wo.files ?? []) as RecFile[]);
    const byPath = new Map(plan.map((f) => [f.path, f]));
    const real = ch?.files ?? d.rec.code.files;
    const out = real.map((f) => ({ ...(byPath.get(f.path) ?? {}), ...f }) as RecFile);
    for (const f of plan) if (!out.some((x) => x.path === f.path)) out.push(f);
    return out;
  }, [ch, d.rec, d.wo]);
  if (!id) return <Picker />;
  if (d.loading) return <div className="view rec-view"><Loading id="chg-loading" label="the changes" /></div>;
  if (d.error || !d.wo || !d.rec || !d.project || !d.cat) {
    const status = (d.error as { status?: number } | null)?.status;
    return <Picker note={status === 403 || status === 404 ? `${id} was not found, or it belongs to a project outside your access. Pick a work order you can see.` : `Could not load the changes of ${id}.`} />;
  }
  const { wo, rec, project, cat } = d;
  const pr = rec.code.pullRequests[0];
  const cur = files[Number(rawFile)] ?? files[0];
  const summary = (
        <Card title="Review summary">
          <p>{rec.summary.written?.text ?? (rec.code.tests.passed + rec.code.tests.failed ? `${rec.code.tests.passed} tests passed, ${rec.code.tests.failed} failed, ${rec.code.tests.added} added. ${files.length} files changed.` : "No review summary has been written yet.")}</p>
          <details className="chg-all" open={!files.length} style={{ marginTop: 12 }}>
            <summary className="linkbtn">Plan, commits and guardrail</summary>
            <div style={{ marginTop: 12 }}>
              <Changes c={{ wo, rec, project, cat, pre: "chg-", compact: false, page: true }} />
            </div>
          </details>
        </Card>
  );
  return (
    <Page
      eyebrow={`Work order \u00b7 ${wo.id}`}
      title="Changes"
      sub={`${pr ? `PR #${pr.number} on ` : ""}${wo.repo}: ${files.length} files, +${sum(files, "plus")} \u2212${sum(files, "minus")}`}
      acts={
        <>
          <a className="btn" id="chg-back" href={hashFor("record", wo.id, wo.project)}>Back to record</a>
          <ReviewBtn wo={wo} id="chg-review" />
        </>
      }
    >
      {files.length ? (
        <div className="chg" id="chg">
          <Card title="Files" acts={<span className="mono dim">{files.length}</span>} flush>
            <div className="list">
              {files.map((f, fi) => {
                const s = split(f.path);
                return (
                  <a key={f.path} className="li click" href={`#/p/${wo.project}/changes/${wo.id}%2F${fi}`} aria-current={f === cur ? "true" : undefined} style={{ color: "inherit", textDecoration: "none", ...(f === cur ? { background: "var(--surface-2)" } : {}) }}
                    onClick={(e) => { e.preventDefault(); navigate("changes", `${wo.id}/${fi}`, wo.project); }}>
                    <div className="main1">
                      <span className="t1 mono" style={{ fontSize: 12 }} title={f.path}>{s.name}</span>
                      <span className="t2 mono">{s.dir}</span>
                    </div>
                    <span className="mono" style={{ fontSize: 11 }}><span style={{ color: "var(--ok)" }}>{`+${f.plus}`}</span>{" "}<span style={{ color: "var(--bad)" }}>{`\u2212${f.minus}`}</span></span>
                  </a>
                );
              })}
            </div>
          </Card>
          <div className="stack" style={{ minWidth: 0 }}>
            <Card title={<span className="mono" style={{ fontSize: 13 }}>{cur?.path}</span>} acts={<span className="dim">{cur?.preview?.length ? "Diff preview" : "No preview stored"}</span>} flush>
              {cur?.preview?.length ? (
                <div className="diff" style={{ border: 0, borderRadius: 0 }}>
                  {cur.preview.map((l, i) => (
                    <div key={i} className={`ln ${l.t === "+" ? "add" : l.t === "-" ? "del" : l.s.startsWith("@@") ? "hh" : ""}`}>
                      <span>{l.s.startsWith("@@") ? "" : i}</span>
                      <span />
                      <span>{l.s.startsWith("@@") ? l.s : l.t === " " ? ` ${l.s}` : `${l.t} ${l.s}`}</span>
                    </div>
                  ))}
                </div>
              ) : <Empty icon="page" title="No diff preview" text="The patch is stored by content hash; open the full review below." />}
            </Card>
            {summary}
          </div>
        </div>
      ) : null}
      {files.length ? null : summary}
    </Page>
  );
}
