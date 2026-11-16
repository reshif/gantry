import { fmt } from "@gantry/domain";
import { useAuditEntry, useMe } from "../../api/queries";
import { Avatar, Btn, Chip, Empty } from "../../ui/primitives";
import { useActors } from "../../ui/actors";
import { Icon } from "../../ui/Icon";
import { navigate } from "../../lib/router";
import { openRecord, setProject, updatePrefs } from "../../lib/prefs";
import { useOpenTraveler } from "../../shell/useTraveler";
import { canSeeRoute } from "../../lib/routes";
import { CAT_ICON, CAT_NAME, topicName, type AuditDetail, type AuditRow } from "./data";

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

const pretty = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
const parse = (v: string | null): { raw: string | null; val?: unknown } => {
  if (v == null) return { raw: null };
  try {
    return { val: JSON.parse(v) as unknown, raw: v };
  } catch {
    return { raw: v };
  }
};

/** Before and after: field by field when both are objects (server diff), else the two sides. */
export function DiffView({ e }: { e: AuditDetail }) {
  if (e.before == null && e.after == null) return <p className="muted small">No before/after recorded for this entry. Config changes record both.</p>;
  if (e.diff) {
    const changed = e.diff.filter((d) => d.changed).length;
    return (
      <div className="aud-diff">
        <p className="small muted">{changed + " of " + e.diff.length + " fields changed"}</p>
        <table className="table table-compact aud-kdiff">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {e.diff.map((d) => (
              <tr key={d.field} className={d.changed ? "is-changed" : ""}>
                <th scope="row" className="mono">{(d.changed ? "~ " : "  ") + d.field}</th>
                <td><pre className="aud-pre aud-del">{d.before == null ? "(none)" : pretty(d.before)}</pre></td>
                <td><pre className="aud-pre aud-ins">{d.after == null ? "(none)" : pretty(d.after)}</pre></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const b = parse(e.before);
  const a = parse(e.after);
  const show = (x: ReturnType<typeof parse>) => (x.raw == null ? "(nothing)" : x.val !== undefined ? pretty(x.val) : x.raw);
  return (
    <div className="aud-ba">
      <div>
        <div className="kicker">Before</div>
        <pre className="aud-pre aud-del">{show(b)}</pre>
      </div>
      <div className="aud-arrow" aria-hidden="true">→</div>
      <div>
        <div className="kicker">After</div>
        <pre className="aud-pre aud-ins">{show(a)}</pre>
      </div>
    </div>
  );
}

/** A button that opens whatever the entry is about, where the viewer's role can see it (legacy entityLink). */
function EntityLink({ e, close }: { e: AuditDetail; close: () => void }) {
  const me = useMe();
  const openTraveler = useOpenTraveler();
  const en = e.entity;
  if (!en || !me) return null;
  const go = (route: string, before?: () => void) => () => {
    before?.();
    close();
    navigate(route);
  };
  const setProj = (pid: string | null) => () => {
    if (pid) setProject(pid);
  };
  const see = (r: string) => canSeeRoute(r, me, {});
  if (en.type === "wo")
    return (
      <span className="row gap-sm">
        <Btn label={`Open record for ${en.id}`} small icon="record" id="aud-ent-record" onClick={() => { close(); openRecord(en.id); }} />
        <Btn label="Open traveler" small kind="ghost" icon="page" id="aud-ent-open" onClick={() => openTraveler(en.id)} />
      </span>
    );
  if (en.type === "role" && see("access")) return <Btn label="Open Access" small icon="lock" id="aud-ent-open" onClick={go("access")} />;
  if ((en.type === "trust" || en.type === "cell" || /^trust\./.test(e.action)) && see("trust"))
    return <Btn label="Open Trust" small icon="trust" id="aud-ent-open" onClick={go("trust", () => { if (e.project) setProject(e.project); updatePrefs({ trustFocus: { cell: String(en.id), project: e.project, cls: null, proposal: null } } as never); })} />;
  if (/^learning\./.test(e.action) && see("learning")) return <Btn label="Open Learning" small icon="learn" id="aud-ent-open" onClick={go("learning")} />;
  if (["class", "station", "bay", "gate"].includes(en.type) && e.project) return <Btn label="Open project config" small icon="tool" id="aud-ent-open" onClick={go("project-config", setProj(e.project))} />;
  if (en.type === "repo" && e.project) return <Btn label="Open onboarding" small icon="branch" id="aud-ent-open" onClick={go("onboarding", setProj(e.project))} />;
  if (en.type === "project" || en.type === "gaterule") {
    const pid = String(en.id).split(":")[0] ?? null;
    return <Btn label="Open project config" small icon="tool" id="aud-ent-open" onClick={go("project-config", setProj(pid))} />;
  }
  if (en.type === "agent") return <Btn label="Open agent" small icon="agent" id="aud-ent-open" onClick={go("agents", () => updatePrefs({ agent: en.id }))} />;
  if (en.type === "person" && see("people")) return <Btn label="Open People" small icon="people" id="aud-ent-open" onClick={go("people")} />;
  return null;
}

export function History({ rows }: { rows: AuditRow[] }) {
  if (!rows.length) return <Empty title="No history yet" text="Changes to this item are written to the audit ledger and appear here." />;
  return (
    <ol className="history">
      {rows.map((e) => (
        <li key={e.seq}>
          <span className="mono muted">{fmt.iso(e.at)}</span>
          <ActorCell id={e.actor} name={e.actorName} />
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
}

function Kv({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="aud-kv">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function AuditDrawer({ seq, projectName, close }: { seq: number; projectName: (id: string | null) => string; close: () => void }) {
  const q = useAuditEntry(seq);
  const e = q.data as AuditDetail | undefined;
  if (q.isError) return <div className="drawer-inner aud-drawer"><Empty title="This entry is not available" text="It may be outside the projects you can see." /></div>;
  if (!e) return <div className="drawer-inner aud-drawer"><p className="muted small" style={{ padding: 16 }}>Loading…</p></div>;
  const topic = topicName(e.topic);
  return (
    <div className="drawer-inner aud-drawer">
      <div className="drawer-head">
        <div>
          <div className="kicker">{"Audit entry · " + (CAT_NAME[e.category] ?? e.category)}</div>
          <div className="drawer-id">
            <span className="mono big-id">{"#" + e.seq}</span>
            <span className={`outcome o-${e.outcome}`}>{e.outcome}</span>
          </div>
          <h2 className="drawer-title">{e.target}</h2>
        </div>
        <button type="button" className="icon-btn drawer-close" id="aud-drawer-close" aria-label="Close" onClick={close}><Icon name="x" /></button>
      </div>
      <div className="drawer-scroll">
        <dl className="aud-kvs">
          <Kv k="When"><span className="mono">{fmt.iso(e.at) + " IST"}</span></Kv>
          <Kv k="Actor"><span><ActorCell id={e.actor} name={e.actorName} /><span className="muted small">{" · " + e.actorKind}</span></span></Kv>
          <Kv k="Action"><span className="mono">{e.action}</span></Kv>
          <Kv k="Category"><span className="row gap-sm"><CatChip c={e.category} />{topic ? <Chip text={topic} /> : null}</span></Kv>
          <Kv k="Project">{e.project ? projectName(e.project) : "Factory-wide"}</Kv>
          <Kv k="Via"><span className="mono">{e.via}</span></Kv>
          {e.onBehalfOf ? <Kv k="On behalf of"><ActorCell id={e.onBehalfOf} /></Kv> : null}
          {e.rule ? <Kv k="Rule"><span className="mono">{e.rule}</span></Kv> : null}
          {e.entity ? <Kv k="Entity"><span className="mono">{e.entity.type + " " + e.entity.id}</span></Kv> : null}
          {e.sourceIp ? <Kv k="Source IP"><span className="mono">{e.sourceIp}</span></Kv> : null}
          {e.session ? <Kv k="Session"><span className="mono">{e.session.id + (e.session.method ? " · " + e.session.method : "")}</span></Kv> : null}
          {e.request.id ? <Kv k="Request"><span className="mono">{e.request.id}</span></Kv> : null}
        </dl>
        {e.outcome === "denied" ? <div className="callout callout-block"><Icon name="lock" />{" The policy engine refused this attempt. Nothing changed."}</div> : null}
        <h3 className="sub-h">Before and after</h3>
        <DiffView e={e} />
        <div className="drawer-actions aud-actions"><EntityLink e={e} close={close} /></div>
        <h3 className="sub-h">Chain</h3>
        <dl className="aud-kvs">
          <Kv k="Digest"><span className="mono digest">{e.digest}</span></Kv>
          <Kv k="Previous"><span className="mono digest">{e.prev}</span></Kv>
        </dl>
        {e.entity ? (
          <div>
            <h3 className="sub-h">{"Other entries for this " + e.entity.type}</h3>
            <History rows={e.history} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

