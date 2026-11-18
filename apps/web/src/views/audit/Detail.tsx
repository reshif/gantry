import { useAuditEntry } from "../../api/queries";
import { Avatar, Empty } from "../../ui/primitives";
import { useActors } from "../../ui/actors";
import { Icon } from "../../ui/Icon";
import { CAT_ICON, CAT_NAME, type AuditDetail } from "./data";

/** Who did it: the name the people and agents lists know, else the name the ledger resolved (API keys, triggers and system show their id). */
export function ActorCell({ id, name }: { id: string; name?: string }) {
  const actor = useActors()(id);
  const label = actor.kind === "other" && name && name !== id ? name : actor.name.replace(" (agent)", "");
  return (
    <span className="who">
      <Avatar id={id} size="sm" />
      <span>{label}</span>
    </span>
  );
}

export function CatChip({ c }: { c: string }) {
  return (
    <span className={`aud-cat aud-cat-${c}`}>
      <Icon name={CAT_ICON[c] ?? "dots"} />
      {CAT_NAME[c] ?? c}
    </span>
  );
}

function Kv({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="aud-kv">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** "15 Jan 15:30", like the ledger table; an entry with no usable time shows a dash instead of throwing. */
const whenOf = (at: unknown): string => {
  const d = typeof at === "number" || typeof at === "string" ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return "–";
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).replace(",", "");
};

/** The prototype's audit drawer: When, Actor, Target, Project, Category, Outcome, Via, Hash, Previous. */
export function AuditDrawer({ seq, projectName, close }: { seq: number; projectName: (id: string | null) => string; close: () => void }) {
  const q = useAuditEntry(seq);
  const e = q.data as AuditDetail | undefined;
  if (q.isError) return <div className="drawer-inner aud-drawer"><Empty title="This entry is not available" text="It may be outside the projects you can see." /></div>;
  if (!e) return <div className="drawer-inner aud-drawer"><p className="muted small" style={{ padding: 16 }}>Loading…</p></div>;
  return (
    <div className="drawer-inner aud-drawer">
      <div className="drawer-head">
        <div>
          <div className="kicker eyebrow">{"Audit entry #" + e.seq}</div>
          <h2 className="drawer-title">{e.action}</h2>
        </div>
        <button type="button" className="icon-btn drawer-close" id="aud-drawer-close" aria-label="Close" onClick={close}><Icon name="x" /></button>
      </div>
      <div className="drawer-scroll">
        <dl className="aud-kvs">
          <Kv k="When"><span className="mono">{whenOf(e.at)}</span></Kv>
          <Kv k="Actor"><ActorCell id={e.actor} name={e.actorName} /></Kv>
          <Kv k="Target"><span className="mono">{e.target}</span></Kv>
          <Kv k="Project">{e.project ? projectName(e.project) : "Factory-wide"}</Kv>
          <Kv k="Category">{e.category}</Kv>
          <Kv k="Outcome"><span className={`chip ${e.outcome === "ok" ? "ok" : e.outcome === "denied" ? "bad" : "warn"}`}>{e.outcome}</span></Kv>
          <Kv k="Via"><span className="mono">{e.via}</span></Kv>
          <Kv k="Hash"><span className="mono digest" style={{ fontSize: 11 }}>{"sha256:" + e.digest}</span></Kv>
          <Kv k="Previous"><span className="mono digest" style={{ fontSize: 11 }}>{"sha256:" + e.prev}</span></Kv>
        </dl>
      </div>
    </div>
  );
}
