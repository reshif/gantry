/**
 * Changes (#changes/WO-x): the prototype's two-column review (files on the left, the selected file's diff on the right), with the
 * plan, commits and the Builder's guardrail kept in the full Changes section below it.
 */
import { useMemo } from "react";
import { navigate, useHash } from "../lib/router";
import { Btn } from "../ui/primitives";
import { Page, Card } from "../ui/cr";
import { useUI } from "../ui/overlay-context";
import { ReviewDialog } from "./dossier/ReviewDialog";
import { reviewGate } from "./dossier/Head";
import { NotFound, statusOf } from "./dossier/kit";
import { Loading } from "../ui/async";
import { Picker } from "./record/Picker";
import { Changes } from "./record/sections2";
import { useChangesRead, useRecordData, sum, type RecFile } from "./record/data";
import { Empty } from "../ui/primitives";

const split = (p: string): { name: string; dir: string } => {
  const i = p.lastIndexOf("/");
  return { name: p.slice(i + 1), dir: i < 0 ? "" : p.slice(0, i) };
};

/** Real line numbers from the hunk headers ("@@ -40,9 +40,22 @@"): the new file's number for added and unchanged lines, the old file's for removed ones. */
export function numbered(lines: Array<{ t: string; s: string }>): Array<{ n: number | null; hunk: boolean }> {
  let o = 0;
  let nn = 0;
  return lines.map((l) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l.s);
    if (m) {
      o = Number(m[1]);
      nn = Number(m[2]);
      return { n: null, hunk: true };
    }
    if (l.t === "+") return { n: nn++, hunk: false };
    if (l.t === "-") return { n: o++, hunk: false };
    o++;
    return { n: nn++, hunk: false };
  });
}

export default function ChangesView() {
  const ui = useUI();
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
    const status = statusOf(d.error);
    return status === 403 || status === 404 ? <NotFound id={id} /> : <Picker note={`Could not load the changes of ${id}.`} />;
  }
  const { wo, rec, project, cat } = d;
  const pr = rec.code.pullRequests[0];
  const cur = files[Number(rawFile)] ?? files[0];
  const rg = reviewGate(wo, cat);
  const noLineComments = () => ui.toast("Line comments are not available yet: the server has no code review comments.", "info");
  const nums = numbered(cur?.preview ?? []);
  const gi = rg ? wo.gateProgress[rg.g.id] : undefined;
  const tests = rec.code.tests;
  return (
    <Page
      eyebrow={`Work order \u00b7 ${wo.id}`}
      title="Changes"
      sub={`${pr ? `PR #${pr.number} on ` : ""}${wo.repo}: ${files.length} files, +${sum(files, "plus")} \u2212${sum(files, "minus")}`}
      acts={
        <>
          <Btn label="Back to record" id="chg-back" onClick={() => navigate("record", wo.id, wo.project)} />
          {rg ? <Btn label={`Review ${rg.g.label}`} kind="ok" id="chg-review" guard={rg.ap} onClick={() => void ui.open((close) => <ReviewDialog wo={wo} gate={rg.g} rec={rec} onClose={close} />)} /> : null}
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
            <Card title={<span className="mono" style={{ fontSize: 13 }}>{cur?.path}</span>} acts={<span className="dim">{cur?.preview?.length ? "Line comments are not available yet" : "No preview stored"}</span>} flush>
              {cur?.preview?.length ? (
                <div className="diff" style={{ border: 0, borderRadius: 0 }}>
                  {cur.preview.map((l, i) => (
                    <div key={i} className={`ln ${l.t === "+" ? "add" : l.t === "-" ? "del" : l.s.startsWith("@@") ? "hh" : ""}`}>
                      <span>{nums[i]?.hunk ? "" : <Btn label={String(nums[i]?.n)} cls="ln-num" aria={`Comment on line ${nums[i]?.n}`} onClick={noLineComments} />}</span>
                      <span />
                      <span>{l.s.startsWith("@@") ? l.s : `${l.t} ${l.s}`}</span>
                    </div>
                  ))}
                </div>
              ) : <Empty icon="page" title="No diff preview" text="The patch is stored by content hash; open the full review below." />}
            </Card>
            <Card title="Review summary">
          <dl className="kv" style={{ margin: 0 }}>
            <dt>Pull request</dt><dd>{pr ? `#${pr.number} ${pr.state}${pr.draft ? " (draft)" : ""}` : "not yet"}</dd>
            <dt>Files</dt><dd>{`${files.length} changed, +${sum(files, "plus")} \u2212${sum(files, "minus")}`}</dd>
            <dt>Tests</dt><dd>{tests.passed + tests.failed + tests.added ? `${tests.passed} passed, ${tests.failed} failed, ${tests.added} added` : "not available"}</dd>
            <dt>Sensitive paths</dt><dd>{files.some((f) => f.protected) ? `${files.filter((f) => f.protected).length} touched` : "none touched"}</dd>
            <dt>Review gate</dt><dd>{rg ? `${rg.g.label} ${rg.g.name}: ${gi ? `${gi.have} of ${gi.need} approvals` : "waiting"}` : "no gate waiting"}</dd>
          </dl>
        </Card>
          </div>
        </div>
      ) : null}
      <details className="chg-all" open={!files.length} style={{ marginTop: 16 }}>
        <summary className="btn sm">Plan, commits and guardrail</summary>
        <div style={{ marginTop: 12 }}>
          <Changes c={{ wo, rec, project, cat, pre: "chg-", compact: false, page: true }} />
        </div>
      </details>
    </Page>
  );
}
