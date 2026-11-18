/**
 * Changes (#changes/WO-x): the prototype's two-column review (files on the left, the selected file's diff on the right), with the
 * plan, commits and the Builder's guardrail kept in the full Changes section below it.
 */
import { Fragment, useMemo, useState } from "react";
import { navigate, useHash } from "../lib/router";
import { useRouteState } from "../lib/queryState";
import { Btn, Who } from "../ui/primitives";
import { Page, Card } from "../ui/cr";
import { useUI } from "../ui/overlay-context";
import { ReviewDialog } from "./dossier/ReviewDialog";
import { reviewGate } from "./dossier/Head";
import { NotFound, statusOf } from "./dossier/kit";
import { Async, Loading } from "../ui/async";
import { ReviewVerdict } from "./dossier/ReviewVerdict";
import type { DiffCommit, DiffFile, DiffHunk, DiffRead } from "../api/types";
import { Picker } from "./record/Picker";
import { Field, Textarea } from "../ui/primitives";
import { Dialog } from "../ui/Overlay";
import { useMe } from "../api/queries";
import { when } from "./dossier/kit";
import { useChangesRead, useDiffRead, useRecordData, sum, type RecFile } from "./record/data";
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

/** One file of the page: the stored diff's entry (when the diff read has it) or just the counts from the commit list. */
type Row = { path: string; oldPath: string | null; status: string; binary: boolean; plus: number; minus: number; approximate: boolean; commits: DiffCommit[]; planned?: RecFile | undefined };

const hunkHead = (h: DiffHunk): string => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.header ? ` ${h.header}` : ""}`;
const STATUS: Record<string, string> = { added: "added", modified: "modified", deleted: "deleted", renamed: "renamed" };
const sha7 = (c: string | null): string => (c ? c.slice(0, 7) : "unknown commit");

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

type NoteMap = Record<string, Note>;

/** One commit's hunks: a header line per hunk, then the lines with their real old and new numbers. A number is a button that opens a note. */
function Hunks({ hunks, k, notes, onComment, who }: { hunks: DiffHunk[]; k: string; notes: NoteMap; onComment: (key: string) => void; who: string | undefined }) {
  return (
    <div className="diff" style={{ border: 0, borderRadius: 0 }}>
      {hunks.map((h, hi) => (
        <Fragment key={hi}>
          <div className="ln hh"><span /><span /><span>{hunkHead(h)}</span></div>
          {h.lines.map((l, li) => {
            const key = `${k}:${hi}:${li}`;
            const n = l.kind === "del" ? l.old : l.new;
            return (
              <Fragment key={li}>
                <div className={`ln ${l.kind === "add" ? "add" : l.kind === "del" ? "del" : ""}`}>
                  <span>{l.kind === "ctx" ? l.old : l.kind === "del" ? <Btn label={String(l.old)} cls="ln-num" aria={`Comment on removed line ${l.old}`} onClick={() => onComment(key)} /> : ""}</span>
                  <span>{l.kind === "del" ? "" : <Btn label={String(n)} cls="ln-num" aria={`Comment on line ${n}`} onClick={() => onComment(key)} />}</span>
                  <span>{`${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}`}</span>
                </div>
                {l.noNewline ? <div className="ln hh"><span /><span /><span>{"\\ No newline at end of file"}</span></div> : null}
                {notes[key] ? (
                  <div className="chg-note" style={{ padding: "8px 12px 8px 100px", background: "var(--surface-2)", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)", font: "13px var(--font)", whiteSpace: "normal" }}>
                    <Who id={who} />{" "}{notes[key]!.text}{" "}<span className="mono dim">{`${when(notes[key]!.at)} · note on this device, not sent`}</span>
                  </div>
                ) : null}
              </Fragment>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The selected file: what the agent actually changed. One commit shows its hunks; a file several commits touched shows one section per commit and says
 * the counts are sums (approximate). Redacted, truncated, binary and missing patches each say so instead of looking like an empty diff.
 */
function FileDiff({ file, read, notes, onComment, who }: { file: Row; read: DiffRead; notes: NoteMap; onComment: (key: string) => void; who: string | undefined }) {
  const many = file.commits.length > 1;
  const note = (text: string, id: string, cls = "") => <p className={`muted small ${cls}`} id={id} style={{ padding: "8px 12px", margin: 0 }}>{text}</p>;
  return (
    <div id="chg-file">
      <div className="row" style={{ gap: 8, padding: "8px 12px", flexWrap: "wrap" }}>
        <span className="tag" id="chg-file-status">{STATUS[file.status] ?? file.status}</span>
        {file.oldPath ? <span className="mono dim small">{`from ${file.oldPath}`}</span> : null}
        {file.binary ? <span className="tag">binary</span> : null}
        {file.approximate ? <span className="tag warn" id="chg-approx" title="More than one commit touched this file">approximate</span> : null}
      </div>
      {read.truncated ? <div className="banner warn" role="status" id="chg-truncated"><div className="grow">The stored diff was larger than Gantry keeps (800 KB), so some files or hunks are left out. The pull request on GitHub has all of it.</div></div> : null}
      {read.redactions ? <div className="banner" role="status" id="chg-redacted"><div className="grow">{`${read.redactions} value${read.redactions === 1 ? "" : "s"} that looked like secrets ${read.redactions === 1 ? "was" : "were"} replaced by [REDACTED:kind] before the diff was stored.`}</div></div> : null}
      {file.approximate ? note(`${file.commits.length} commits touched this file, so the counts are sums over those commits and can differ from the pull request's net diff.`, "chg-approx-note") : null}
      {file.binary ? <Empty icon="page" title="Binary file" text="Gantry keeps no text diff for a binary file." id="chg-binary" /> : null}
      {!file.binary && !file.commits.length ? <Empty icon="page" title="No stored diff" text={read.truncated ? "This file is not in the stored diff: it was left out when the diff was cut at 800 KB." : "Gantry has no stored patch for this file yet. It is listed from the plan or the commit list."} id="chg-nodiff" /> : null}
      {!file.binary ? file.commits.map((c, ci) => {
        const gone = read.missingPatches.includes(c.patch);
        return (
          <section key={`${c.patch}:${ci}`} aria-label={many ? `Commit ${sha7(c.commit)}` : "Diff"} id={`chg-commit-${ci}`}>
            {many ? <div className="row" style={{ gap: 8, padding: "6px 12px", background: "var(--surface-2)", borderTop: "1px solid var(--line)" }}><span className="mono small">{`Commit ${sha7(c.commit)}`}</span><span className="tag">{STATUS[c.status] ?? c.status}</span><span className="mono small"><span style={{ color: "var(--ok)" }}>{`+${c.plus}`}</span>{" "}<span style={{ color: "var(--bad)" }}>{`\u2212${c.minus}`}</span></span></div> : null}
            {gone ? <Empty icon="page" title="Patch no longer stored" text={`The text of this commit's patch (${c.patch}) is gone, so its changes to this file cannot be shown.`} id={`chg-missing-${ci}`} />
              : c.hunks.length ? <Hunks hunks={c.hunks} k={`${file.path}:${ci}`} notes={notes} onComment={onComment} who={who} />
              : note("This commit changed the file without any line changes the patch could show (for example a mode change or an empty file).", `chg-nohunks-${ci}`)}
          </section>
        );
      }) : null}
    </div>
  );
}

export default function ChangesView() {
  const ui = useUI();
  const hash = useHash();
  const [rawId = "", legacyFile = ""] = (hash.param || "").split("/");
  // the selected file is URL state (?f=<index>), so a reload or a pasted link opens the same file
  const [fileQ, setFileQ] = useRouteState("f", "");
  const rawFile = fileQ || legacyFile;
  const id = rawId.toUpperCase();
  const me = useMe();
  const [notes, setNotes] = useState<Record<string, Note>>(() => readNotes(id));
  const d = useRecordData(id || null);
  const ch = useChangesRead(id || null).data;
  const diffQ = useDiffRead(id || null);
  const diff = diffQ.data;
  const files: Row[] = useMemo(() => {
    if (!d.rec || !d.wo) return [];
    const plan = ((d.wo.files ?? []) as RecFile[]);
    const byPath = new Map(plan.map((f) => [f.path, f]));
    // The diff read has one entry per path across commits; without it (loading or failed) the commit list is folded to one row per path, with no hunks.
    const real: Row[] = diff
      ? diff.files.map((f: DiffFile) => ({ ...f }))
      : byFile(ch?.files ?? d.rec.code.files).map((f) => ({ path: f.path, oldPath: null, status: f.status, binary: false, plus: f.plus, minus: f.minus, approximate: false, commits: [] }));
    const out = real.map((f) => ({ ...f, planned: byPath.get(f.path) }));
    for (const f of plan) if (!out.some((x) => x.path === f.path)) out.push({ path: f.path, oldPath: null, status: f.status, binary: false, plus: f.plus, minus: f.minus, approximate: false, commits: [], planned: f });
    return out;
  }, [ch, diff, d.rec, d.wo]);
  if (!id) return <Picker />;
  if (d.loading) return <div className="view rec-view"><Loading id="chg-loading" label="the changes" /></div>;
  if (d.error || !d.wo || !d.rec || !d.project || !d.cat) {
    const status = statusOf(d.error);
    return status === 403 || status === 404 ? <NotFound id={id} /> : <Picker note={`Could not load the changes of ${id}.`} />;
  }
  const { wo, rec, cat } = d;
  const pr = rec.code.pullRequests[0];
  const cur: Row | undefined = files[Number(rawFile)] ?? files[0];
  const rg = reviewGate(wo, cat);
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
                    onClick={(e) => { e.preventDefault(); setFileQ(String(fi)); }}>
                    <div className="main1">
                      <span className="t1 mono" style={{ fontSize: 12 }} title={f.path}>{s.name}</span>
                      <span className="t2 mono">{s.dir}{f.approximate ? `${s.dir ? " · " : ""}${f.commits.length} commits` : ""}</span>
                    </div>
                    <span className="mono" style={{ fontSize: 11 }}>{f.binary ? "binary" : <><span style={{ color: "var(--ok)" }}>{`+${f.plus}`}</span>{" "}<span style={{ color: "var(--bad)" }}>{`\u2212${f.minus}`}</span></>}</span>
                  </a>
                );
              })}
            </div>
          </Card>
          <div className="stack" style={{ minWidth: 0 }}>
            <Card title={<span style={{ fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{cur?.path}</span>} acts={<span className="dim" style={{ whiteSpace: "nowrap" }}>{cur?.commits.some((c) => c.hunks.length) ? "Click a line number to comment" : ""}</span>} flush>
              <Async<DiffRead> query={diffQ} what="the stored diff" id="chg-diff" rows={6}>
                {(dr) => (cur ? <FileDiff file={cur} read={dr} notes={notes} onComment={comment} who={me?.person.id} /> : null)}
              </Async>
            </Card>
            <Card title="Review summary">
              <p id="chg-summary">{`${pr ? `Pull request #${pr.number} is ${pr.state}${pr.draft ? " (draft)" : ""}` : "No pull request yet"}: ${files.length} files, +${sum(files, "plus")} \u2212${sum(files, "minus")}. ${tests.passed + tests.failed + tests.added ? `Tests: ${tests.passed} passed, ${tests.failed} failed, ${tests.added} added.` : "Tests: not available."} ${files.some((f) => f.planned?.protected) ? `${files.filter((f) => f.planned?.protected).length} sensitive paths touched.` : "No sensitive paths touched."} ${rg ? `${rg.g.label} ${rg.g.name} has ${gi ? `${gi.have} of ${gi.need}` : "no"} approvals.` : "No gate is waiting."}`}</p>
              <div style={{ marginTop: 12 }}><ReviewVerdict review={rec.review} id="chg-review-verdict" /></div>
            </Card>
          </div>
        </div>
      ) : null}
      {files.length ? null : <div className="card"><Empty icon="page" title="No changes yet" text="Nothing has been pushed for this work order." /></div>}
    </Page>
  );
}
