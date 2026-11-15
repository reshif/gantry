import { useAudit } from "../../api/queries";
import { fmt } from "@gantry/domain";
import type { AuditEntry } from "@gantry/domain";
import { Empty, Who } from "../../ui/primitives";

/** A before/after value as one short line: role lists by name, with the reason when the change carried one. */
const show = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  const o = v as { roles?: unknown; role?: unknown; scope?: unknown; reason?: unknown };
  const what = o.roles != null ? String(o.roles) : o.role != null ? `${String(o.role)}${o.scope ? ` @ ${String(o.scope)}` : ""}` : "";
  return [what, o.reason ? `"${String(o.reason)}"` : ""].filter(Boolean).join(" ") || JSON.stringify(v);
};

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
          <span className="muted small">{e.before != null || e.after != null ? `${show(e.before)} → ${show(e.after)}` : e.target}</span>
        </li>
      ))}
    </ul>
  );
}
