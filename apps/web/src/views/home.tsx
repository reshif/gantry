/**
 * Home (#home), the Control Room plant overview: stat row, what needs a person next to the live activity, the belt at a glance next
 * to throughput, then the projects as a tile grid. Everything is read through the typed hooks; the API decides which sections
 * a person gets (`home.sections`) and this page renders what is present, never checking a role.
 */
import { useMemo } from "react";
import { fmt } from "@gantry/domain";
import { useCan } from "../api/can";
import { useActivity, useHome, useMe, useProjects } from "../api/queries";
import { eventRows, eventText, hourly, eventTone } from "../lib/eventText";
import { hashFor, navigate } from "../lib/router";
import { setProject, usePrefs } from "../lib/prefs";
import { pickProject } from "../lib/routes";
import { Btn, Chip, Empty } from "../ui/primitives";
import { useActors } from "../ui/actors";
import { Async } from "../ui/async";
import { Bars, Card, CrEmpty, CrIcon, Lamp, ListItem, MiniBeltCr, Page, Stats, type MiniStation, type StatItem } from "../ui/cr";
import { type HomeFull } from "./home/data";
import { useReviewApproval } from "./inbox/ApprovalDialog";
import { agoShort, titleOf, useItems } from "./inbox/kit";
import { RestoreAction, SetupChecklist, openNewProject } from "./home/sections";
import { StateBody, useStateOverride } from "./ops1/stateOverride";
import { metricsOf, useCatalog, type PView } from "./projects/kit";

export { openNewProject };


export default function HomeView() {
  const me = useMe();
  const q = useHome();
  const projectsData: unknown = useProjects().data;
  const projects = useMemo(() => (Array.isArray(projectsData) ? projectsData : []) as PView[], [projectsData]);
  const cat = useCatalog();
  const prefs = usePrefs();
  const activity = useActivity();
  const actors = useActors();
  const review = useReviewApproval();
  const submit = useCan("wo.submit");
  const home = q.data as HomeFull | undefined;
  const events = useMemo(() => eventRows(activity.data), [activity.data]);
  const names = useMemo(() => new Map(projects.map((p) => [p.id, p.name] as [string, string])), [projects]);
  const allItems = useItems(home, names);
  const override = useStateOverride();

  if (!me) return null;
  if (override) {
    return (
      <Page eyebrow="Operate" title="Home" cls="hm">
        <StateBody state={override} />
      </Page>
    );
  }
  if (!home) {
    return (
      <Page eyebrow="Operate" title="Home">
        <Async query={q} what="your home page" id="hm">{() => null}</Async>
      </Page>
    );
  }
  const s = home.sections ?? {};
  if (s.access === "none") {
    return (
      <Page eyebrow="Operate" title="Home">
        <Empty id="hm-no-access" title="No access yet" text="Your account is signed in but has no role yet. Ask a Factory Admin or Project Admin to give you one." />
      </Page>
    );
  }

  const scopeId = pickProject(me, prefs.project);
  const scoped = prefs.scopeAll ? [] : projects.filter((p) => p.id === scopeId);
  const inView = scoped.length ? scoped : projects;
  const scopeName = prefs.scopeAll ? "All projects" : (scoped[0]?.name ?? "All projects");
  const nameOf = (id: string | null | undefined) => actors(id).name.replace(" (agent)", "");
  const hr = new Date().getHours();
  const greet = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  const away = me.person.away && me.person.away.to > Date.now() ? ` Away until ${fmt.istDate(me.person.away.to)}.` : "";

  /* what needs a person (prototype: the open approvals, five of them, with the count of all open): gate and onboarding approvals and the proposals and restores the server
     puts in front of this person, in the inbox's order. Health items (a blocked work order, a halted project) are not approvals: they show in the Blocked tile and the project tiles. */
  const items = allItems.filter((i) => (!scoped.length || i.project === scoped[0]?.id) && (i.kind === "gate" || i.kind === "onboarding" || i.kind === "other") && !(i.kind === "other" && i.x.restore?.scope === "factory"));
  const att = s.attention ?? [];
  const killBanner = att.find((a) => a.restore?.scope === "factory");
  const waitSub = (ms: number) => (ms ? ` · waiting ${agoShort(ms)}` : "");
  const rows = items.map((i) => {
    const t = titleOf(i);
    const gate = i.kind === "gate" ? i.a : null;
    return {
      key: i.key,
      title: gate ? `${gate.gateLabel ?? gate.gate} ${gate.gateName ?? "gate"} for ${gate.wo}` : String(t.title),
      sub: `${i.kind === "other" ? i.x.sub || i.x.where : String(t.sub)}${waitSub(i.waitMs)}`,
      it: i,
    };
  });
  const waitingN = rows.length;

  /* stats */
  const m = s.motion;
  const buckets = hourly(events);
  const statItems: StatItem[] = [];
  const blocked = inView.reduce((t, p) => t + metricsOf(p).bad, 0);
  const atGates = items.filter((i) => i.kind === "gate").length;
  // On the belt follows the scope: the work in progress of the projects in view (the server's factory-wide motion counts only when all projects are in view).
  const onBelt = scoped.length ? inView.reduce((t, p) => t + metricsOf(p).wip, 0) : (m?.inFlight ?? 0);
  const runningNow = scoped.length ? Math.min(m?.running ?? 0, onBelt) : (m?.running ?? 0);
  if (m) statItems.push({ l: "On the belt", v: onBelt, d: `${runningNow} running · ${Math.max(0, onBelt - runningNow)} queued`, tone: "info", spark: buckets });
  if (s.waiting || s.attention) statItems.push({ l: "Waiting for a person", v: waitingN, d: `${atGates} at gates`, tone: waitingN ? "warn" : "ok" });
  if (m) statItems.push({ l: "Released today", v: m.shippedToday, d: "median cycle n/a", tone: "ok" });
  if (projects.length) statItems.push({ l: "Blocked", v: blocked, d: "oldest n/a", tone: "bad" });
  if (s.health) statItems.push({ l: "Spend today", v: "n/a", d: `month $${s.health.spend.spent.toFixed(2)} of $${s.health.spend.budget.toFixed(2)}`, tone: "agent" });

  /* belt at a glance: stations across, work in progress per station summed over the projects in view */
  const stations: MiniStation[] = (cat?.stations ?? []).map((st) => {
    const n = inView.reduce((t, p) => t + (metricsOf(p).byPosition[st.id]?.n ?? 0), 0);
    const gate = cat?.gates.find((g) => g.after === st.id);
    const gateWaiting = gate ? inView.reduce((t, p) => t + (metricsOf(p).byGate[gate.id] ?? 0), 0) > 0 : false;
    // Capacity is each project's configured WIP for the station (coding slots for Build), summed over the projects in view.
    const slots = Math.max(1, inView.reduce((t, p) => t + (st.id === "build" ? p.flow.slots : (p.flow.stations[st.id]?.wip ?? 0)), 0));
    return { id: st.id, name: st.name, n, slots, gate: gateWaiting, href: hashFor("floor", null, scopeId) };
  });

  const canSubmit = !submit.pending && submit.allowed && !s.setup;
  const feed = events.slice(0, 7);

  return (
    <Page
      eyebrow="Operate"
      title={`${greet}, ${me.person.name.split(" ")[0]}`}
      sub={`Plant overview for ${scopeName}. Agents propose, people approve.${away}`}
      cls="hm"
      acts={
        <>
          <a className="btn" href={hashFor("floor", null, scopeId)}><CrIcon name="floor" />Open floor</a>
          {canSubmit ? <a className="btn primary" id="hm-my-new" href={hashFor("console")}><CrIcon name="plus" />Submit work order</a> : null}
        </>
      }
    >
      {killBanner ? (
        <div className="banner bad" role="alert" style={{ marginBottom: 16 }}>
          <CrIcon name="stop" />
          <div className="grow"><b>Factory stopped.</b> {killBanner.sub} Restore needs two Factory Admins.</div>
          <RestoreAction item={killBanner} startLabel="Start restore" small={false} />
        </div>
      ) : null}
      {s.setup ? <div style={{ marginBottom: 16 }}><SetupChecklist setup={s.setup} /></div> : null}
      {statItems.length ? <Stats items={statItems} id="hm-stats" /> : null}
      <div className="grid g-main rows" style={{ marginBottom: 16 }}>
        <Card title="Needs your attention" flush hint={`${rows.length} open`} acts={<a className="btn sm" href="#inbox">Open inbox</a>} id="hm-attention">
          {rows.length ? (
            <div>
              {rows.slice(0, 5).map((r) => (
                <ListItem key={r.key} tone="warn" title={r.title} sub={r.sub}>
                  <Btn label="Review" small kind="primary" id={`hm-review-${r.key}`} onClick={() => { if (r.it.kind === "onboarding") { if (r.it.a.project) setProject(r.it.a.project); navigate("onboarding", r.it.a.repo); } else review(r.it); }} />
                </ListItem>
              ))}
            </div>
          ) : (
            <CrEmpty title="Nothing waiting for you" text="Agents are working. You will see approvals here as they appear." icon="check" />
          )}
        </Card>
        <Card title="Live activity" hint="Moves, approvals and completions" id="hm-activity">
          {feed.length ? (
            <div className="tl">
              {feed.map((e) => (
                <div key={e.id} className={eventTone(e)}>
                  <div>{e.type === "wo.enter" ? `${e.wo ?? ""} moved to ${cat?.stations.find((x) => x.id === e.station)?.name ?? e.station ?? "a station"}`.trim() : eventText(e, cat, nameOf)}</div>
                  <div className="when">{fmt.ago(e.at, Date.now())}</div>
                </div>
              ))}
            </div>
          ) : (
            <CrEmpty title="No recent activity" text="Moves, approvals and completions appear here as they happen." icon="inbox" />
          )}
        </Card>
      </div>
      <div className="grid g-main rows" style={{ marginBottom: 16 }}>
        <Card title="Belt at a glance" hint="Work orders per station. Dashed line = capacity; amber bar = over it; amber dot = gate waiting" acts={<a className="btn sm" href={hashFor("floor", null, scopeId)}>Floor</a>} id="hm-belt">
          <div style={{ padding: "4px 0" }}>{stations.length ? <MiniBeltCr stations={stations} /> : <CrEmpty title="No stations" text="The line has not loaded." icon="floor" />}</div>
        </Card>
        <Card title="Throughput, last 24 hours" hint="Work orders completing a station per hour" id="hm-throughput">
          <Bars data={buckets} w={240} h={96} label="Station entries per hour" />
          <div className="row spread dim mono" style={{ fontSize: 11, margin: "6px 0 0 24px" }}><span>-24h</span><span>-12h</span><span>now</span></div>
        </Card>
      </div>
      {inView.length ? (
        <Card title="Projects" flush hint={`${inView.length} in view`} id="hm-projects" >
          <div className="proj-grid">
            {inView.map((p) => {
              const mt = metricsOf(p);
              return (
                <a key={p.id} className="ptile" href={hashFor("project-config", null, p.id)}>
                  <Lamp tone={p.killed ? "bad" : p.halted ? "warn" : mt.bad ? "bad" : "ok"} />
                  <div className="main1">
                    <span className="t1">{p.name}</span>
                    <span className="t2">{mt.wip} on belt · {mt.bad} blocked</span>
                  </div>
                  {p.killed ? <Chip text="Killed" cls="bad" /> : p.halted ? <Chip text="Halted" cls="warn" /> : <span className="mono dim">{p.key}</span>}
                </a>
              );
            })}
          </div>
        </Card>
      ) : null}
    </Page>
  );
}

