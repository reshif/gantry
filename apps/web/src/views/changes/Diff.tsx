/**
 * The diff of one file on the Changes page: the agent's own hunks with old and new line numbers, from GET /work-orders/:id/diff. A file touched by more than one commit
 * is shown commit by commit and marked approximate (the totals are sums, not the net change). Every state a patch can be in is said in words: truncated at the size
 * limit, secrets redacted, binary, or its stored text gone. Nothing here is written by Gantry; it is what the commits contain.
 */
import type { DiffCommit, DiffFile, WoDiff } from "../../api/queries";
import { Chip } from "../../ui/primitives";

const short = (sha: string | null): string => (sha ? sha.slice(0, 7) : "no commit");

function Hunks({ c }: { c: DiffCommit }) {
  if (!c.hunks.length) return <p className="dfv-note muted" role="note">No text changes recorded in this commit (a mode change or an empty patch).</p>;
  return (
    <>
      {c.hunks.map((h, i) => (
        <div key={i} className="dfv-hunk" role="group" aria-label={`Hunk at old line ${h.oldStart}, new line ${h.newStart}`}>
          <div className="dfv-head mono">{`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.header ? ` ${h.header}` : ""}`}</div>
          {h.lines.map((l, j) => (
            <div key={j} className={`dfv-row ${l.kind}`}>
              <span className="n" aria-label="old line">{l.old ?? ""}</span>
              <span className="n" aria-label="new line">{l.new ?? ""}</span>
              <span className="t">{`${l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "} ${l.text}`}{l.noNewline ? <span className="muted"> (no newline at end of file)</span> : null}</span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/** The honest reason a file the record lists has no hunks (it is not in the diff read). */
export function whyNoDiff(diff: WoDiff | undefined, failed: boolean): string {
  if (failed) return "The diff could not be loaded, so the changed lines are not shown.";
  if (!diff) return "Loading the diff…";
  if (diff.truncated) return "Not shown: the diff passed its size limit (800 KB) before reaching this file.";
  if (diff.missingPatches.length) return "Not shown: the stored text of a patch is gone, so this file's lines cannot be displayed.";
  return "No patch text was stored for this file.";
}

export function FileDiff({ file, diff, commitMessage }: { file: DiffFile; diff: WoDiff; commitMessage: (sha: string | null) => string }) {
  const many = file.commits.length > 1;
  return (
    <div className="dfv" id="chg-diff" role="group" aria-label={`Diff of ${file.path}`}>
      {diff.truncated ? <p className="dfv-note callout warn" role="note" id="chg-truncated">The diff is larger than the display limit (800 KB), so later files or lines are missing. The file list is complete.</p> : null}
      {diff.redactions > 0 ? <p className="dfv-note callout" role="note" id="chg-redacted">{`${diff.redactions} secret${diff.redactions === 1 ? "" : "s"} in this diff ${diff.redactions === 1 ? "was" : "were"} replaced by [REDACTED:kind] before it was stored.`}</p> : null}
      {diff.missingPatches.length ? <p className="dfv-note callout warn" role="note" id="chg-missing-patch">{`The stored text of ${diff.missingPatches.length} patch${diff.missingPatches.length === 1 ? " is" : "es are"} gone, so ${diff.missingPatches.length === 1 ? "its" : "their"} changes are not shown here.`}</p> : null}
      {file.oldPath ? <p className="dfv-note small muted">{`Renamed from ${file.oldPath}`}</p> : null}
      {many ? <p className="dfv-note callout" role="note" id="chg-approx">{`Approximate: ${file.commits.length} commits touched this file, so +${file.plus} −${file.minus} adds up each commit's changes rather than the net change. Each commit is shown separately.`}</p> : null}
      {file.binary ? (
        <p className="dfv-note" id="chg-binary">Binary file: it changed, but there is no text diff to show.</p>
      ) : file.commits.length ? (
        file.commits.map((c) => (
          <section key={c.patch} className="dfv-sec" aria-label={many ? `Commit ${short(c.commit)}` : "Changes"}>
            {many ? (
              <h4>
                <span className="mono">{short(c.commit)}</span>
                <span className="grow trunc">{commitMessage(c.commit)}</span>
                <Chip text={c.status} cls="plain" />
                <span className="num small">{`+${c.plus} −${c.minus}`}</span>
              </h4>
            ) : null}
            <Hunks c={c} />
          </section>
        ))
      ) : <p className="dfv-note muted">No patch text was stored for this file.</p>}
    </div>
  );
}
