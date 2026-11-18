import { useAudit } from "../../api/queries";
import type { AuditEntry } from "@gantry/domain";
import { Empty } from "../../ui/primitives";

/** The prototype's time stamp: "17 Nov 21:54" (day, short month, 24-hour time). */
const when = (t: number): string => { const d = new Date(t); return `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`; };

/** The newest audit entries that mention an entity (legacy G.historyList). */
export function HistoryList({ id, limit = 8 }: { id: string; limit?: number }) {
  const q = useAudit({ q: id, limit });
  if (q.isPending) return <p className="muted small">Loading history.</p>;
  if (q.isError) return <p className="muted small">The audit log is not available to you.</p>;
  const raw = q.data;
  const items: AuditEntry[] = (Array.isArray(raw) ? raw : raw?.items ?? []).slice(0, limit);
  if (!items.length) return <Empty title="No history yet" text="Changes to this person appear here." />;
  return (
    <div className="tl" id="ppl-history-list">
      {items.map((e) => (
        <div key={e.id} className="info">
          <div className="mono">{`${e.action} ${e.target}`}</div>
          <div className="when">{when(e.at)}</div>
        </div>
      ))}
    </div>
  );
}
