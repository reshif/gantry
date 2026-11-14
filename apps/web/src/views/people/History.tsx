import { useAudit } from "../../api/queries";
import { fmt } from "@gantry/domain";
import type { AuditEntry } from "@gantry/domain";
import { Empty, Who } from "../../ui/primitives";

/** The newest audit entries that mention an entity (legacy G.historyList). */
export function HistoryList({ id, limit = 8 }: { id: string; limit?: number }) {
  const q = useAudit({ q: id, limit });
  if (q.isPending) return <p className="muted small">Loading history.</p>;
  if (q.isError) return <p className="muted small">The audit log is not available to you.</p>;
  const raw = q.data;
  const items: AuditEntry[] = (Array.isArray(raw) ? raw : raw?.items ?? []).slice(0, limit);
  if (!items.length) return <Empty title="No history yet" text="Changes to this person appear here." />;
  return (
    <ul className="history">
      {items.map((e) => (
        <li key={e.id}>
          <span className="mono small">{fmt.stamp(e.at)}</span> <Who id={e.actor} /> <span className="strong">{e.action}</span>{" "}
          <span className="muted small">{e.before != null || e.after != null ? `${e.before ?? ""} → ${e.after ?? ""}` : e.target}</span>
        </li>
      ))}
    </ul>
  );
}
