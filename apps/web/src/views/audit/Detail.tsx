import { fmt } from "@gantry/domain";
import { useAuditEntry, useMe } from "../../api/queries";
import { Btn, Chip, Empty, IconBtn } from "../../ui/primitives";
import { useActors } from "../../ui/actors";
import { navigate } from "../../lib/router";
import { openRecord, setProject, updatePrefs } from "../../lib/prefs";
import { useOpenTraveler } from "../../shell/useTraveler";
import { canSeeRoute } from "../../lib/routes";
import { dayMon } from "../govern/listkit";
import type { AuditDetail } from "./data";

/** Who did it, as a name: the one the people and agents lists know, else the name the ledger resolved (API keys, triggers and system show their id). */
export function useActorName(): (id: string, name?: string) => string {
  const actors = useActors();
  return (id, name) => {
    const actor = actors(id);
    return actor.kind === "other" && name && name !== id ? name : actor.name.replace(" (agent)", "");
  };
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


const pretty = (v: string | null): string => {
  if (v == null) return "";
  try {
    const x: unknown = JSON.parse(v);
    return typeof x === "string" ? x : JSON.stringify(x, null, 2);
  } catch {
    return v;
  }
};

/** The ledger entry drawer, as the Blueprint draws it: eyebrow, action, date and actor, a key-value list and the before/after lines. No footer. */
export function AuditDrawer({ seq, projectName, close }: { seq: number; projectName: (id: string | null) => string; close: () => void }) {
  const q = useAuditEntry(seq);
  const name = useActorName();
  const e = q.data as AuditDetail | undefined;
  const head = (title: string, sub?: string) => (
    <header>
      <div style={{ minWidth: 0 }}>
        <div className="micro">{`LEDGER ENTRY #${seq}`}</div>
        <h2>{title}</h2>
        {sub ? <div className="muted small">{sub}</div> : null}
      </div>
      <IconBtn icon="x" label="Close" className="drawer-close ghost" id="aud-drawer-close" onClick={close} />
    </header>
  );
  if (q.isError) return <>{head("Not available")}<div className="body"><Empty title="This entry is not available" text="It may be outside the projects you can see." /></div></>;
  if (!e) return <>{head("Loading…")}<div className="body"><p className="muted small">Loading…</p></div></>;
  return (
    <>
      {head(e.action, `${dayMon(e.at)} \u00b7 ${name(e.actor, e.actorName)}`)}
      <div className="body">
        <div className="stack">
          <dl className="kv">
            <dt>Target</dt><dd>{e.target}</dd>
            <dt>Category</dt><dd><Chip text={e.category} cls="plain" /></dd>
            <dt>Where</dt><dd>{e.project ? projectName(e.project) : "factory"}</dd>
            <dt>Via</dt><dd>{e.via}</dd>
            <dt>Outcome</dt><dd><Chip text={e.outcome} cls={e.outcome === "ok" ? "ok" : "bad"} /></dd>
            <dt>Entity</dt><dd>{e.entity ? `${e.entity.type} \u00b7 ${e.entity.id}` : "\u2014"}</dd>
          </dl>
          {e.before != null || e.after != null ? (
            <div className="diff pre">
              <div className="d">{`\u2212 ${pretty(e.before)}`}</div>
              <div className="a">{`+ ${pretty(e.after)}`}</div>
            </div>
          ) : null}
          {e.entity ? <div className="row"><EntityLink e={e} close={close} /></div> : null}
          <dl className="kv" aria-label="Chain">
            <dt>Digest</dt><dd className="mono small">{e.digest}</dd>
            <dt>Previous</dt><dd className="mono small">{e.prev}</dd>
            <dt>Time</dt><dd className="mono small">{`${fmt.iso(e.at)} IST`}</dd>
          </dl>
        </div>
      </div>
    </>
  );
}
