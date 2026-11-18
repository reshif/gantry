import { fmt } from "@gantry/domain";
import { useAudit } from "../../api/queries";
import type { AuditEntry } from "../../api/types";
import { Empty, Who } from "../../ui/primitives";
import { Async } from "../../ui/async";

/** Audit history for one entity (legacy G.historyList): entries about `type`/`id` in `project`. A refused or failed read says so; it never looks like an empty list. */
export function HistoryList({ type, id, project, limit = 50 }: { type: string; id: string; project: string; limit?: number }) {
  const q = useAudit({ project, limit: 200 });
  return (
    <Async query={q} what="history" id={`pcf-hist-${type}`}>
      {(raw) => {
        const all: AuditEntry[] = Array.isArray(raw) ? raw : ((raw as { items?: AuditEntry[] }).items ?? []);
        const list = all.filter((e) => (e.entity && e.entity.type === type && e.entity.id === id) || (type === "project" && e.project === id)).slice(0, limit);
        if (!list.length) return <Empty title="No history yet" text="Changes to this item are written to the audit ledger and appear here." />;
        return (
          <ol className="history">
            {list.map((e) => (
              <li key={e.id}>
                <span className="mono muted">{fmt.iso(e.at)}</span>
                <Who id={e.actor} />
                <span className="mono">{e.action}</span>
                <span>{e.target}</span>
                {e.before != null || e.after != null ? (
                  <span className="diff-ba mono small">
                    <del>{String(e.before)}</del>{" → "}<ins>{String(e.after)}</ins>
                  </span>
                ) : null}
                <span className={`outcome o-${e.outcome}`}>{e.outcome}</span>
              </li>
            ))}
          </ol>
        );
      }}
    </Async>
  );
}
