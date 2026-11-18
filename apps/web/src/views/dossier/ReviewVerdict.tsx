/**
 * What the Review agent decided, as the server recorded it (record.review, and basis.review on the gate): the verdict, its notes, the verdict per
 * acceptance criterion and the findings with file and line. Code only shows what the agent wrote; nothing here is composed by the screen.
 */
import { Chip } from "../../ui/primitives";
import type { RecReview } from "../record/data";

const VERDICT: Record<RecReview["verdict"], { label: string; cls: string }> = {
  approve: { label: "Approved", cls: "ok" },
  changes_requested: { label: "Changes requested", cls: "bad" },
  none: { label: "No verdict", cls: "idle" },
};
const RESULT: Record<string, { label: string; cls: string }> = { pass: { label: "Passed", cls: "ok" }, fail: { label: "Failed", cls: "bad" }, untested: { label: "Not tested", cls: "idle" } };
const SEV: Record<string, string> = { critical: "bad", major: "bad", minor: "warn", nit: "idle" };

export function ReviewVerdict({ review, id = "rv-verdict" }: { review: RecReview | null | undefined; id?: string }) {
  if (!review) return <p className="muted small" id={`${id}-none`}>The Review agent has not recorded a verdict on this work order yet.</p>;
  const v = VERDICT[review.verdict] ?? VERDICT.none;
  return (
    <div className="stack" id={id} style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="label">Review agent</span>
        <Chip text={v.label} cls={v.cls} />
        {review.headSha ? <span className="mono dim small">{`at ${review.headSha.slice(0, 7)}`}</span> : null}
      </div>
      {review.notes ? <p className="small" style={{ whiteSpace: "pre-wrap" }}>{review.notes}</p> : null}
      {review.criteria.length ? (
        <ul className="plain-list small" aria-label="Review verdict per criterion">
          {review.criteria.map((c, i) => {
            const r = RESULT[c.result] ?? RESULT.untested!;
            return (
              <li key={i}>
                <Chip text={r.label} cls={r.cls} />{" "}{c.criterion}
                {c.evidence ? <span className="dim">{` (${c.evidence})`}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {review.findings.length ? (
        <ul className="plain-list small" aria-label="Review findings">
          {review.findings.map((f, i) => (
            <li key={i}>
              <Chip text={f.severity} cls={SEV[f.severity] ?? "idle"} />{" "}
              {f.file ? <span className="mono">{`${f.file}${f.line ? `:${f.line}` : ""}`}</span> : null}{f.file ? " " : ""}{f.issue}
              {f.fix ? <span className="dim">{` Fix: ${f.fix}`}</span> : null}
            </li>
          ))}
        </ul>
      ) : <p className="muted small">The Review agent listed no findings.</p>}
    </div>
  );
}
