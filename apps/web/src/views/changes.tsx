/**
 * Changes (#changes/WO-x): the prototype's two-column review (files on the left, the selected file's diff on the right), with the
 * plan, commits and the Builder's guardrail kept in the full Changes section below it.
 */
import { Fragment, useMemo, useState } from "react";
import { navigate, useHash } from "../lib/router";
import { Btn, Who } from "../ui/primitives";
import { Page, Card } from "../ui/cr";
import { useUI } from "../ui/overlay-context";
import { ReviewDialog } from "./dossier/ReviewDialog";
import { reviewGate } from "./dossier/Head";
import { NotFound, statusOf } from "./dossier/kit";
import { Loading } from "../ui/async";
import { Picker } from "./record/Picker";
import { Field, Textarea } from "../ui/primitives";
import { Dialog } from "../ui/Overlay";
import { useMe } from "../api/queries";
import { when } from "./dossier/kit";
import { useChangesRead, useRecordData, sum, type RecFile } from "./record/data";
import { Empty } from "../ui/primitives";

const split = (p: string): { name: string; dir: string } => {
  const i = p.lastIndexOf("/");
  return { name: p.slice(i + 1), dir: i < 0 ? "" : p.slice(0, i) };
};

/** One row per file: the read lists a file once per commit that touched it, so add the commits' counts up and keep the latest status. */
export function byFile<T extends { path: string; plus: number; minus: number }>(rows: T[]): T[] {
  const m = new Map<string, T>();
  for (const f of rows) {
    const a = m.get(f.path);
    const patch = [(a as { patch?: string } | undefined)?.patch, (f as { patch?: string }).patch].filter(Boolean).join("");
    m.set(f.path, a ? { ...a, ...f, plus: a.plus + f.plus, minus: a.minus + f.minus, ...(patch ? { patch } : {}) } : { ...f });
  }
  return [...m.values()];
}

/** A unified diff body as the preview lines ("+", "-", " " and "@@" headers), when the server sends the patch text. */
export function previewOf(patch: unknown): Array<{ t: string; s: string }> | undefined {
  if (typeof patch !== "string" || !patch) return undefined;
  return patch.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === "") && !/^(diff --git|index |--- |\+\+\+ )/.test(l)).map((l) => (l.startsWith("@@") ? { t: " ", s: l } : { t: l[0] === "+" || l[0] === "-" ? l[0] : " ", s: l.slice(1) }));
}

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

/**
 * Notes on lines. The server has no code review comments, so a note is kept in this browser only and says so: it is never shown
 * as if the author, the agent or the other approvers could see it.
 */
const NOTES_KEY = (id: string) => `gantry.line-notes.${id}`;
type Note = { text: string; at: number };
function readNotes(id: string): Record<string, Note> {
  try {
    return JSON.parse(window.localStorage.getItem(NOTES_KEY(id)) || "{}") as Record<string, Note>;
  } catch {
    return {};
  }
}
function LineNoteDialog({ onSave, onClose }: { onSave: (text: string) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  return (
    <Dialog
      title="Comment on line"
      onClose={onClose}
      dirty={text.length > 0}
      body={
        <div className="form-grid" id="chg-note">
          <Field label="Comment" htmlFor="chg-note-text" required hint="The server has no code review comments yet: this note stays in this browser.">
            <Textarea id="chg-note-text" rows={3} value={text} onChange={(e) => { setText(e.target.value); setErr(""); }} />
          </Field>
          <div className="form-err" role="alert">{err}</div>
        </div>
      }
      actions={[{ label: "Cancel" }, { label: "Add comment", kind: "primary", submit: true, id: "chg-note-add", onClick: (close) => { if (text.trim().length < 3) return setErr("The comment needs at least 3 characters."); onSave(text.trim()); close(); } }]}
    />
  );
}

export default function ChangesView() {
  const ui = useUI();
  const hash = useHash();
  const [pathPart = "", qs = ""] = (hash.param || "").split("?");
  const [rawId = "", legacyFile = ""] = pathPart.split("/");
  const rawFile = new URLSearchParams(qs).get("f") ?? legacyFile;
  const id = rawId.toUpperCase();
  const me = useMe();
  const [notes, setNotes] = useState<Record<string, Note>>(() => readNotes(id));
  const d = useRecordData(id || null);
  const ch = useChangesRead(id || null).data;
  const files: RecFile[] = useMemo(() => {
    if (!d.rec || !d.wo) return [];
    const plan = ((d.wo.files ?? []) as RecFile[]);
    const byPath = new Map(plan.map((f) => [f.path, f]));
    const real = byFile(ch?.files ?? d.rec.code.files);
    const out = real.map((f) => {
      const patch = previewOf((f as { patch?: unknown }).patch);
      return { ...(byPath.get(f.path) ?? {}), ...f, ...(patch && !(f as RecFile).preview?.length ? { preview: patch } : {}) } as RecFile;
    });
    for (const f of plan) if (!out.some((x) => x.path === f.path)) out.push(f);
    return out;
  }, [ch, d.rec, d.wo]);
  if (!id) return <Picker />;
  if (d.loading) return <div className="view rec-view"><Loading id="chg-loading" label="the changes" /></div>;
  if (d.error || !d.wo || !d.rec || !d.project || !d.cat) {
    const status = statusOf(d.error);
    return status === 403 || status === 404 ? <NotFound id={id} /> : <Picker note={`Could not load the changes of ${id}.`} />;
  }
  const { wo, rec, cat } = d;
  const pr = rec.code.pullRequests[0];
  const cur = files[Number(rawFile)] ?? files[0];
  const rg = reviewGate(wo, cat);
  const fileIdx = Math.max(0, files.indexOf(cur as RecFile));
  const comment = (key: string) =>
    void ui.open((close) => (
      <LineNoteDialog
        onClose={close}
        onSave={(text) => {
          const next = { ...notes, [key]: { text, at: Date.now() } };
          setNotes(next);
          try { window.localStorage.setItem(NOTES_KEY(id), JSON.stringify(next)); } catch { /* the note stays for this visit */ }
          ui.toast("Comment added", "ok");
        }}
      />
    ));
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
                  <a key={f.path} className="li click" href={`#/p/${wo.project}/changes/${wo.id}?f=${fi}`} aria-current={f === cur ? "true" : undefined} style={{ color: "inherit", textDecoration: "none", ...(f === cur ? { background: "var(--surface-2)" } : {}) }}
                    onClick={(e) => { e.preventDefault(); window.location.hash = `#/p/${wo.project}/changes/${wo.id}?f=${fi}`; }}>
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
            <Card title={<span style={{ fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{cur?.path}</span>} acts={<span className="row"><span className="dim" style={{ whiteSpace: "nowrap" }}>{cur?.preview?.length ? "Click a line number to comment" : "No stored diff for this file"}</span></span>} flush>
              {cur?.preview?.length ? (
                <div className="diff" style={{ border: 0, borderRadius: 0 }}>
                  {cur.preview.map((l, i) => (
                    <Fragment key={i}>
                      <div className={`ln ${l.t === "+" ? "add" : l.t === "-" ? "del" : l.s.startsWith("@@") ? "hh" : ""}`}>
                        <span>{nums[i]?.hunk ? "" : <Btn label={String(nums[i]?.n)} cls="ln-num" aria={`Comment on line ${nums[i]?.n}`} onClick={() => comment(`${fileIdx}:${i}`)} />}</span>
                        <span />
                        <span>{l.s.startsWith("@@") ? l.s : `${l.t} ${l.s}`}</span>
                      </div>
                      {notes[`${fileIdx}:${i}`] ? (
                        <div className="chg-note" style={{ padding: "8px 12px 8px 100px", background: "var(--surface-2)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)", font: "13px var(--font)", whiteSpace: "normal" }}>
                          <Who id={me?.person.id} />{" "}{notes[`${fileIdx}:${i}`]!.text}{" "}<span className="mono dim">{`${when(notes[`${fileIdx}:${i}`]!.at)} · note on this device, not sent`}</span>
                        </div>
                      ) : null}
                    </Fragment>
                  ))}
                </div>
              ) : <Empty icon="page" title="No diff preview" text="The server has no stored patch for this file (it may be a binary or very large change). The counts on the left are the sums over the commits that touched it, which can differ from the pull request's net diff." />}
            </Card>
            <Card title="Review summary">
              <p>{`${pr ? `Pull request #${pr.number} is ${pr.state}${pr.draft ? " (draft)" : ""}` : "No pull request yet"}: ${files.length} files, +${sum(files, "plus")} \u2212${sum(files, "minus")}. ${tests.passed + tests.failed + tests.added ? `Tests: ${tests.passed} passed, ${tests.failed} failed, ${tests.added} added.` : "Tests: not available."} ${files.some((f) => f.protected) ? `${files.filter((f) => f.protected).length} sensitive paths touched.` : "No sensitive paths touched."} ${rg ? `${rg.g.label} ${rg.g.name} has ${gi ? `${gi.have} of ${gi.need}` : "no"} approvals.` : "No gate is waiting."} The review agent's findings are not recorded by the server yet.`}</p>
            </Card>
          </div>
        </div>
      ) : null}
      {files.length ? null : <div className="card"><Empty icon="page" title="No changes yet" text="Nothing has been pushed for this work order." /></div>}
    </Page>
  );
}
