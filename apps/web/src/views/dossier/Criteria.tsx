/**
 * Acceptance criteria against Verify's record: each criterion is Passed, Failed or Not tested, with the test runs the verdict names, and the
 * test counts of the run on top. A criterion Verify did not report stays "Not tested"; nothing is guessed here.
 */
import type { Criterion } from "@gantry/domain";
import { critStatus, type RecordData } from "../record/data";

export const CRIT_TONE: Record<string, string> = { met: "ok", failed: "bad", pending: "warn", untested: "idle" };

export function TestCounts({ tests }: { tests: RecordData["code"]["tests"] }) {
  const ran = tests.passed + tests.failed;
  return (
    <p className="small" id="crit-counts" style={{ margin: "0 0 8px" }}>
      {ran ? `Verify ran ${ran} test${ran === 1 ? "" : "s"}: ${tests.passed} passed, ${tests.failed} failed${tests.added ? `, ${tests.added} added` : ""}.` : <span className="muted">Verify has recorded no test run for this work order.</span>}
    </p>
  );
}

export function CriteriaList({ criteria, tests, empty }: { criteria: Criterion[]; tests: RecordData["code"]["tests"]; empty: string }) {
  if (!criteria.length) return <p className="muted small">{empty}</p>;
  return (
    <div id="crit-list">
      <TestCounts tests={tests} />
      <div className="list" style={{ border: "1px solid var(--line)", borderRadius: 6 }}>
        {criteria.map((c) => {
          const s = critStatus(c);
          return (
            <div className="li" key={c.id} id={`crit-${c.id}`}>
              <span className="mono dim">{c.id}</span>
              <div className="main1">
                <span className="t1" style={{ whiteSpace: "normal" }}>{c.text}</span>
                <span className="t2">{c.tests.length ? c.tests.map((t) => `${t.result === "pass" ? "passed" : "failed"}: ${t.name}`).join(" · ") : s.id === "untested" ? "no test run reported for this criterion" : "no named test"}</span>
              </div>
              <span className={`chip ${CRIT_TONE[s.id] ?? "idle"}`}>{s.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
