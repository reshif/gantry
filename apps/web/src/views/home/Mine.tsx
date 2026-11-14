import { useCan } from "../../api/can";
import { useMe, useProjects } from "../../api/queries";
import { ops } from "../../api/ops";
import { Btn, Chip, Empty, Panel, ViewHead } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { hasCommand, runCommand } from "../../lib/commands";
import { navigate } from "../../lib/router";
import { setProject, updatePrefs } from "../../lib/prefs";
import { useOpenTraveler } from "../../shell/useTraveler";
import { WO_STATES, fmt } from "@gantry/domain";
import { ClassChip, HealthChip, MiniBelt, classOf, goProject, useCatalog, type PView } from "../projects/kit";
import type { Approval, HomeFull, MineWo } from "./data";

function Stat({ k, v, sub, tone, id }: { k: string; v: string; sub: string; tone?: string | null; id: string }) {
  return (
    <div className={`stat hm-stat${tone ? ` tone-${tone}` : ""}`} id={id}>
      <div className="stat-k">{k}</div>
      <div className="stat-v">{v}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

const inFlight = (w: MineWo): boolean => w.state !== "done" && w.state !== "killed" && w.bay !== "declined";

function Token({ w, p }: { w: MineWo; p?: PView }) {
  const open = useOpenTraveler();
  const cat = useCatalog();
  const glyph = (WO_STATES as Record<string, { glyph: string; label: string }>)[w.state] ?? { glyph: "dots", label: w.state };
  const note = w.state === "running" ? null : w.state === "waiting" ? "waiting on a gate" : w.state === "parked" ? w.bayName ?? "Parked" : w.state === "killed" ? "Killed" : w.state === "blocked" ? "Blocked" : w.state === "failed" ? "Check failed" : w.state === "done" ? "Shipped" : "";
  return (
    <button type="button" className={`tok tok-${w.state}`} id={`hm-tok-${w.id}`} data-wo={w.id} aria-label={`${w.id}, ${w.title}, ${glyph.label}${note ? `, ${note}` : ""}`} onClick={() => open(w.id)}>
      <span className="tok-top">
        <Icon name={glyph.glyph} className="tok-glyph" />
        <span className="mono tok-id">{w.id}</span>
      </span>
      <span className="tok-title">{w.title}</span>
      <span className={`tok-foot${w.state === "running" ? "" : " has-note"}`}>
        {cat && p ? <ClassChip cls={classOf(cat, p, w.cls)} small /> : null}
        <span className="tok-note">{note}</span>
      </span>
    </button>
  );
}

function ApprovalRow({ a }: { a: Approval }) {
  const ui = useUI();
  const open = useOpenTraveler();
  if (a.repo) {
    return (
      <li className="hm-my-row">
        <Icon name="rocket" className="hm-my-ic" />
        <div className="hm-my-main">
          <div>{`Merge onboarding PR ${a.repoName}#${a.pr}`}</div>
          <div className="muted small">{a.projectName + " · checks green"}</div>
        </div>
        <Btn label="Open onboarding" small id={`hm-my-onb-${a.repo}`} onClick={() => goProject(a.project, "onboarding")} />
      </li>
    );
  }
  const wo = a.wo ?? "";
  const gate = a.gate ?? "";
  const approve = async () => {
    const r = await ops.approveGate(wo, gate);
    ui.toast(r.msg, r.ok ? "ok" : "error");
  };
  return (
    <li className="hm-my-row">
      <span className="gate gate-waiting gate-sm" aria-label={`${a.gateName} (${a.gateLabel}): waiting on approvers`}>
        <span className="gate-shape" aria-hidden="true"><span className="gate-count">{String(a.need !== undefined ? Math.max(1, a.need - (a.have ?? 0)) : 1)}</span></span>
      </span>
      <div className="hm-my-main">
        <div><span className="mono">{wo}</span>{" · " + a.gateName + " · " + a.gateLabel + (a.need !== undefined ? ` · ${a.have ?? 0} of ${a.need} approval${a.need === 1 ? "" : "s"}` : "")}</div>
        <div className="muted small">{`${a.title} · ${a.projectName}${a.need !== undefined ? ` · ${a.have ?? 0} of ${a.need} approvals` : ""}${a.waitMs ? ` · waiting ${fmt.dur(a.waitMs)}` : ""}`}</div>
      </div>
      <div className="hm-my-acts">
        <Btn label="Review" small kind="ghost" id={`hm-my-open-${wo}-${gate}`} onClick={() => open(wo)} />
        {gate === "G0G1" ? null : <Btn label={gate === "G6" ? "Confirm release" : "Approve"} small kind="primary" id={`hm-my-ok-${wo}-${gate}`} onClick={() => void approve()} />}
      </div>
    </li>
  );
}

/** My work: what is waiting for me across the projects I belong to (legacy myWork). */
export function MyWork({ home, onFactory }: { home: HomeFull; onFactory: () => void }) {
  const me = useMe();
  const cat = useCatalog();
  const projects = ((useProjects().data ?? []) as PView[]).slice();
  const submit = useCan("wo.submit");
  if (!me || !cat) return null;
  const { approvals, conversations, mine } = home;
  const myProjects = mine.projects.map((mp) => ({ mp, p: projects.find((p) => p.id === mp.id) })).filter((x): x is { mp: (typeof mine.projects)[number]; p: PView } => !!x.p);
  const live = mine.workOrders.filter(inFlight);
  const shipped = mine.workOrders.filter((w) => w.state === "done").length;
  const newWo = hasCommand("newWorkOrder") ? () => runCommand("newWorkOrder") : null;
  const away = me.person.away && me.person.away.to > Date.now() ? "until " + fmt.istDate(me.person.away.to) : "no";
  return (
    <div className="view hm hm-mine">
      <ViewHead
        kicker="Home · My work" title="My work" sub={`What is waiting for ${me.person.name} across ${myProjects.length} project${myProjects.length === 1 ? "" : "s"}.`}
        meta={[["Signed in", me.person.name], ["On call", me.person.oncall ? "yes" : "no"], ["Away", away]]}
        actions={
          <>
            {newWo ? <Btn label="New work order" kind="primary" icon="plus" id="hm-my-new" guard={submit} onClick={newWo} /> : null}
            {mine.factoryRole ? <Btn label="Factory overview" kind="ghost" icon="home" id="hm-to-factory" onClick={onFactory} /> : null}
          </>
        }
      />
      <div className="stats hm-kpis hm-kpis-4" role="group" aria-label="My work summary">
        <Stat id="hm-my-k1" k="My approvals" v={String(approvals.length)} sub={approvals.length ? "gates and PRs you may approve now" : "nothing waiting"} tone={approvals.length ? "wait" : null} />
        <Stat id="hm-my-k2" k="My work orders" v={String(live.length)} sub={`in flight · ${shipped} shipped this week`} />
        <Stat id="hm-my-k3" k="Questions for me" v={String(conversations.length)} sub="intake conversations and raised questions" tone={conversations.length ? "wait" : null} />
        <Stat id="hm-my-k4" k="My projects" v={String(myProjects.length)} sub={mine.factoryRole ? "factory-wide role" : "where you hold a role"} />
      </div>
      <div className="hm-my-grid">
        <Panel title="My approvals" tools={<span className="mono small muted">{String(approvals.length)}</span>}>
          {approvals.length ? <ul className="hm-my-list">{approvals.map((a) => <ApprovalRow key={`${a.wo ?? a.repo}-${a.gate ?? ""}`} a={a} />)}</ul> : <Empty title="No approvals waiting" text="Gates you are allowed to approve, and onboarding PRs you may merge, appear here." />}
        </Panel>
        <Panel title="Conversations awaiting my answers" tools={<span className="mono small muted">{String(conversations.length)}</span>}>
          {conversations.length ? (
            <ul className="hm-my-list">
              {conversations.map((w) => (
                <li key={w.wo} className="hm-my-row">
                  <Icon name="chat" className="hm-my-ic" />
                  <div className="hm-my-main">
                    <div><span className="mono">{w.wo}</span>{" · " + w.title}</div>
                    <div className="muted small">{w.question || "Confirm the brief or answer the open question."}</div>
                  </div>
                  <Btn label="Answer" small kind="primary" id={`hm-my-conv-${w.wo}`} onClick={() => { setProject(w.project); updatePrefs({ openConversation: w.wo }); navigate("conversations"); }} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No questions for you" text="When the Intake agent or a later station needs your answer, it shows here." />
          )}
        </Panel>
        <Panel title="My work orders" tools={<span className="mono small muted">{String(mine.workOrders.length)}</span>}>
          {mine.workOrders.length ? (
            <div className="hm-my-toks">
              {mine.workOrders.map((w) => (
                <div key={w.id} className="hm-my-tok">
                  <Token w={w} p={projects.find((x) => x.id === w.project)} />
                  <div className="small muted">{`${w.projectName} · ${w.bay ? w.bayName ?? w.bay : w.station}`}</div>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="No work orders from you" text="Work orders you submit appear here with their station and state." action={newWo ? <Btn label="New work order" small id="hm-my-new2" guard={submit} onClick={newWo} /> : undefined} />
          )}
        </Panel>
        <Panel title="My projects" tools={<span className="mono small muted">{String(myProjects.length)}</span>}>
          {myProjects.length ? (
            <ul className="hm-my-projs">
              {myProjects.map(({ mp, p }) => (
                <li key={p.id} className="hm-my-proj">
                  <div className="hm-proj-head">
                    <div className="hm-proj-name"><span className="mono hm-key">{p.key}</span><h3>{p.name}</h3></div>
                    <HealthChip p={p} />
                  </div>
                  <div className="small"><span className="kv-k">Your roles here </span>{mp.roles.map((r) => <Chip key={r.id} text={r.name} cls="chip-accent" />)}</div>
                  <MiniBelt cat={cat} project={p} counts={p.metrics?.byPosition ?? {}} onStation={() => goProject(p.id, "floor")} />
                  <div className="hm-proj-actions">
                    <Btn label="Floor" small icon="belt" id={`hm-my-floor-${p.id}`} aria={`Open the floor for ${p.name}`} onClick={() => goProject(p.id, "floor")} />
                    <Btn label="Work orders" small kind="ghost" id={`hm-my-wos-${p.id}`} aria={`Work orders in ${p.name}`} onClick={() => goProject(p.id, "work-orders")} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No projects yet" text="Ask a Project Admin to add you to a project." />
          )}
        </Panel>
      </div>
    </div>
  );
}
