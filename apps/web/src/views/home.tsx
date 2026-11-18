/**
 * Home (#home), the Control Room plant overview: stat row, what needs a person next to the live activity, the belt at a glance next
 * to throughput, then the projects as a tile grid. Everything is read through the typed hooks; the API decides which sections
 * a person gets (`home.sections`) and this page renders what is present, never checking a role.
 */
import { useMemo } from "react";
import { fmt } from "@gantry/domain";
import { useCan } from "../api/can";
import { useActivity, useHome, useMe, useProjects } from "../api/queries";
import { hasCommand, runCommand } from "../lib/commands";
import { eventRows, eventText, eventTone } from "../lib/eventText";
import { hashFor, navigate } from "../lib/router";
import { setProject, updatePrefs, usePrefs } from "../lib/prefs";
import { pickProject } from "../lib/routes";
import { useOpenTraveler } from "../shell/useTraveler";
import { Btn, Chip, Empty } from "../ui/primitives";
import { useActors } from "../ui/actors";
import { Async } from "../ui/async";
import { Bars, Card, CrEmpty, CrIcon, Lamp, ListItem, MiniBeltCr, Page, Stats, type MiniStation, type StatItem } from "../ui/cr";
import { type HomeFull, goAttention } from "./home/data";
import { useReviewApproval } from "./inbox/ApprovalDialog";
import { gateItem, titleOf } from "./inbox/kit";
import { RestoreAction, SetupChecklist, openNewProject } from "./home/sections";
import { metricsOf, useCatalog, type PView } from "./projects/kit";

export { openNewProject };

const HOUR_MS = 3_600_000;

export default function HomeView() {
  const me = useMe();
  const q = useHome();
  const projectsData: unknown = useProjects().data;
  const projects = (Array.isArray(projectsData) ? projectsData : []) as PView[];
  const cat = useCatalog();
  const prefs = usePrefs();
  const activity = useActivity();
  const actors = useActors();
  const openTraveler = useOpenTraveler();
  const review = useReviewApproval();
  const create = useCan("project.create");
  const submit = useCan("wo.submit");
  const home = q.data as HomeFull | undefined;
  const events = useMemo(() => eventRows(activity.data), [activity.data]);

  if (!me) return null;
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
  const scoped = projects.filter((p) => p.id === scopeId);
  const inView = scoped.length ? scoped : projects;
  const scopeName = scoped[0]?.name ?? "all projects";
  const nameOf = (id: string | null | undefined) => actors(id).name.replace(" (agent)", "");
  const hr = new Date().getHours();
  const greet = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  const away = me.person.away && me.person.away.to > Date.now() ? ` Away until ${fmt.istDate(me.person.away.to)}.` : "";

  /* what needs a person: attention items first, then gate and onboarding approvals, then questions; nothing twice */
  const attIds = new Set((s.attention ?? []).map((a) => a.id));
  const waiting = s.waiting
    ? {
        approvals: s.waiting.approvals.filter((a) => !(a.repo && !a.note && attIds.has(`hm-att-onb-${a.repo}`)) && !(a.wo && attIds.has(`hm-att-sla-${a.wo}-${a.gate}`))),
        conversations: s.waiting.conversations,
      }
    : null;
  const att = s.attention ?? [];
  const killBanner = att.find((a) => a.restore?.scope === "factory");
  const waitingN = waiting ? waiting.approvals.length + waiting.conversations.length : 0;
  const rows = [
    ...att.map((a) => ({
      key: a.id,
      tone: (a.sev === 0 ? "bad" : "warn") as "bad" | "warn",
      title: a.title,
      sub: `${a.where}${a.sub ? ` · ${a.sub}` : ""}`,
      action: a.restore ? (a === killBanner ? <Btn label={a.act.label} small onClick={() => goAttention(a.act, openTraveler)} /> : <RestoreAction item={a} />) : <Btn label={a.act.label} small kind="primary" onClick={() => goAttention(a.act, openTraveler)} />,
    })),
    ...(waiting?.approvals ?? []).map((a, i) => ({
      key: `ap-${a.wo ?? a.repo}-${i}`,
      tone: "warn" as const,
      title: a.repo
        ? (a.note ? `Onboarding ${a.repoName ?? a.repo}` : `Merge onboarding PR ${a.repoName ?? a.repo}#${a.pr ?? ""}`)
        : String(titleOf(gateItem(a)).title),
      sub: a.repo
        ? `${a.note ?? "Checks green"} · ${a.projectName}${a.waitMs ? ` · waiting ${fmt.dur(a.waitMs)} ago` : ""}`
        : `${a.wo} · ${a.title ?? ""}${a.waitMs ? ` · waiting ${fmt.dur(a.waitMs)} ago` : ""}`,
      action: (
        <Btn
          label="Review" small kind="primary"
          onClick={() => {
            if (a.repo) {
              if (a.project) setProject(a.project);
              navigate("onboarding", a.repo);
            } else if (a.wo) review(gateItem(a));
          }}
        />
      ),
    })),
    ...(waiting?.conversations ?? []).map((c) => ({
      key: `cv-${c.wo}`,
      tone: "warn" as const,
      title: `${c.wo} · ${c.gate ? `${c.gate.label} ${c.gate.name}` : "questions for you"}`,
      sub: c.title,
      action: (
        <Btn
          label="Open" small kind="primary"
          onClick={() => {
            updatePrefs({ project: c.project, openConversation: c.wo });
            navigate("conversations");
          }}
        />
      ),
    })),
  ];

  /* stats */
  const m = s.motion;
  const buckets = hourly(events);
  const statItems: StatItem[] = [];
  const blocked = inView.reduce((t, p) => t + metricsOf(p).bad, 0);
  const atGates = (waiting?.approvals ?? []).filter((a) => a.gate).length;
  if (m) statItems.push({ l: "On the belt", v: m.inFlight, d: `${m.running} running · ${Math.max(0, m.inFlight - m.running)} queued`, tone: "info", spark: buckets });
  if (waiting || s.attention) statItems.push({ l: "Waiting for a person", v: waitingN, d: `${atGates} at gates`, tone: waitingN ? "warn" : "ok" });
  if (m) statItems.push({ l: "Released today", v: m.shippedToday, d: `${m.shippedWeek} this week · median cycle not available`, tone: "ok" });
  if (projects.length) statItems.push({ l: "Blocked", v: blocked, d: "oldest: not available", tone: "bad" });
  if (s.health) statItems.push({ l: "Spend this month", v: `$${s.health.spend.spent.toFixed(2)}`, d: `budget $${s.health.spend.budget.toFixed(2)}`, tone: "agent" });

  /* belt at a glance: stations across, work in progress per station summed over the projects in view */
  const stations: MiniStation[] = (cat?.stations ?? []).map((st) => {
    const n = inView.reduce((t, p) => t + (metricsOf(p).byPosition[st.id]?.n ?? 0), 0);
    const gate = cat?.gates.find((g) => g.after === st.id);
    const gateWaiting = gate ? inView.reduce((t, p) => t + (metricsOf(p).byGate[gate.id] ?? 0), 0) > 0 : false;
    // Capacity is each project's configured WIP for the station (coding slots for Build), summed over the projects in view.
    const slots = Math.max(1, inView.reduce((t, p) => t + (st.id === "build" ? p.flow.slots : (p.flow.stations[st.id]?.wip ?? 0)), 0));
    return { id: st.id, name: st.name, n, slots, gate: gateWaiting, href: hashFor("floor", null, scopeId) };
  });

  const canCreate = !create.pending && create.allowed && !s.setup;
  const canSubmit = !submit.pending && submit.allowed && !s.setup && hasCommand("newWorkOrder");
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
          {canSubmit ? <Btn label="Submit work order" kind="primary" icon="plus" id="hm-my-new" onClick={() => void runCommand("newWorkOrder")} /> : null}
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
                <ListItem key={r.key} tone={r.tone} title={r.title} sub={r.sub}>{r.action}</ListItem>
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
      {projects.length ? (
        <Card title="Projects" flush hint={`${projects.length} in view`} id="hm-projects" acts={canCreate ? <Btn small label="New project" icon="plus" id="hm-new-project" onClick={openNewProject} /> : undefined}>
          <div className="proj-grid">
            {projects.map((p) => {
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

/** Station entries per hour over the last 24 hours (oldest first), from the activity feed. */
function hourly(events: Array<{ at: number; type: string }>): number[] {
  const now = Date.now();
  const out = Array.from({ length: 24 }, () => 0);
  for (const e of events) {
    if (e.type !== "wo.enter") continue;
    const age = Math.floor((now - e.at) / HOUR_MS);
    if (age >= 0 && age < 24) out[23 - age] = (out[23 - age] ?? 0) + 1;
  }
  return out;
}
