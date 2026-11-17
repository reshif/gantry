/** The Journey tab: the station-by-station routing sheet with its gates, the journey scrubber and the after-release outcomes (legacy traveler.js journey). */
import { useEffect, useRef, type ReactElement } from "react";
import { TRUST_LEVELS, flowOf, fmt, gateAfter, gateDef, gateKind, gatePendingName, woTotals, type Catalog, type Project } from "@gantry/domain";
import { useAgents } from "../../api/queries";
import { Btn, Avatar, StateChip } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useOpenTraveler } from "../../shell/useTraveler";
import { useName } from "../record/bits";
import { useRecordRead } from "../record/data";
import { bayLabel, journeyOf, openEntry, stName, toRecEvent, type RecEvent, type TWo } from "./model";
import { setScrub, useScrub } from "./state";

const trustTag = (n: number, pre?: string) => {
  const L = TRUST_LEVELS.find((x) => x.level === n);
  return (
    <span className={`trv-lv trv-lv-${n}`} title={L ? `${L.code} ${L.name}: ${L.desc}` : `L${n}`}>
      {(pre ?? "") + (L ? `${L.code} ${L.name}` : `L${n}`)}
    </span>
  );
};

function evText(e: RecEvent, cat: Catalog, name: (id: string) => string): string {
  const gd = e.gate ? gateDef(cat, e.gate) : undefined;
  const st = e.station ? cat.stations.find((s) => s.id === e.station) : undefined;
  const g = gd ? `${gd.label} ${gd.name}` : (e.gate ?? "");
  switch (e.type) {
    case "wo.submit": return `Submitted by ${name(e.by)}${e.text ? `: ${e.text}` : ""}`;
    case "wo.enter": return `Entered ${st ? `${st.no} ${st.name}` : (e.station ?? "")}`;
    case "gate.decision": return `${g} ${e.mode === "auto" ? "passed on its checks" : e.mode === "trust" ? "passed under trust" : `approved by ${name(e.by)}`}`;
    case "trust.auto": return `${g} passed under trust${e.trust != null ? ` at L${e.trust}` : ""}`;
    case "wo.bay": return e.bay ? `Moved to ${bayLabel(cat, e.bay)}${e.text ? `: ${e.text}` : ""}` : "Back on the belt";
    case "release": return `Released ${e.text ?? ""}`.trim();
    case "wo.done": return "Finished";
    case "kill": return `Killed by ${name(e.by)}${e.text ? `: ${e.text}` : ""}`;
    case "restore": return `Restored by ${name(e.by)}${e.text ? `: ${e.text}` : ""}`;
    default: return e.text || e.type;
  }
}

function Scrubber({ wo, events, sc, cat }: { wo: TWo; events: RecEvent[]; sc: number | null; cat: Catalog }) {
  const name = useName();
  const n = events.length;
  const i = sc != null ? Math.min(sc, n - 1) : n - 1;
  const e = events[i];
  const drag = useRef(false);
  if (!n || !e) return null;
  const on = sc != null;
  return (
    <section className={`trv-scrub${on ? " is-on" : ""}`} aria-label="Journey scrubber">
      <div className="trv-sc-head">
        <span className="trv-sc-t">
          <Icon name="replay" />
          {on ? `History · step ${i + 1}` : "Journey history"}
        </span>
        <span className="trv-sc-btns">
          <Btn label="Previous" small icon="back" id="trv-scrub-prev" disabledReason={i <= 0 ? "Already at the first step." : null} onClick={() => setScrub(wo.id, Math.max(0, i - 1))} />
          <Btn label="Next" small icon="chevron" id="trv-scrub-next" disabledReason={!on || i >= n - 1 ? (on ? "Already at the last step." : "Pick an earlier step first.") : null} onClick={() => setScrub(wo.id, i + 1)} />
          {on ? <Btn label="Show current" small kind="ghost" icon="x" id="trv-scrub-live" onClick={() => setScrub(wo.id, null)} /> : null}
        </span>
      </div>
      <div className="trv-sc-track">
        <input
          type="range"
          className="trv-sc-range"
          id="trv-scrub"
          min={0}
          max={n - 1}
          step={1}
          value={i}
          aria-label={`Step through ${wo.id}'s history`}
          aria-valuetext={`Step ${i + 1} of ${n}: ${evText(e, cat, name)}`}
          onPointerDown={() => (drag.current = true)}
          onChange={(ev) => setScrub(wo.id, Number(ev.target.value))}
          onPointerUp={() => (drag.current = false)}
        />
        <div className="trv-sc-ticks" aria-hidden="true">
          {events.map((x, k) => (
            <span key={k} className={`trv-sc-tick tk-${x.type.replace(".", "-")}${k <= i ? " is-past" : ""}`} style={{ left: `${(n > 1 ? (k / (n - 1)) * 100 : 0).toFixed(2)}%` }} />
          ))}
        </div>
      </div>
      <span className="trv-sc-text" id="trv-scrub-text" aria-live="polite">
        <span className="mono">{`Step ${i + 1} of ${n} · ${fmt.stamp(e.at)}`}</span>
        <span>{evText(e, cat, name)}</span>
      </span>
    </section>
  );
}

function Outcomes({ wo }: { wo: TWo }) {
  const open = useOpenTraveler();
  const list = wo.outcomes ?? [];
  if (wo.state !== "done" && !list.length) return null;
  const icon: Record<string, string> = { healthy: "check", revert: "undo", incident: "alert", followup: "branch" };
  return (
    <section className="trv-after">
      <h3 className="sub-h">After release</h3>
      {wo.pr && wo.pr.releasedAt ? <p className="small">{`Released ${wo.pr.tag || ""} on ${fmt.stamp(wo.pr.releasedAt)}.`}</p> : null}
      {list.length ? (
        <ul className="checklist small">
          {list.map((o, i) => (
            <li key={i} className={o.kind === "healthy" ? "ok" : (o.kind as string) === "followup" ? "pending" : "bad"}>
              <Icon name={icon[o.kind] || "alert"} />
              <span>
                <strong>{o.kind === "healthy" ? "Healthy" : o.kind === "revert" ? "Reverted" : o.kind === "incident" ? `Incident${o.severity ? ` (${o.severity})` : ""}` : "Follow-up"}</strong>
                {` · ${fmt.stamp(o.at)} · ${o.text}`}
              </span>
              {(o as { wo?: string }).wo ? <Btn label={`Open ${(o as { wo?: string }).wo}`} small kind="ghost" id={`trv-out-${(o as { wo?: string }).wo}`} onClick={() => open((o as unknown as { wo: string }).wo)} /> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{wo.split ? "Split into child work orders; outcomes are tracked on each child." : "Watching after release. Outcomes appear here."}</p>
      )}
    </section>
  );
}

export function Journey({ wo, project, cat }: { wo: TWo; project: Project; cat: Catalog }) {
  const name = useName();
  const agents = useAgents().data ?? [];
  const rec = useRecordRead(wo.id).data;
  const events = journeyOf((rec?.events ?? []).map(toRecEvent)).filter((e) => e.type !== "trust.change");
  const scIdx = useScrub(wo.id);
  const sc = events.length && scIdx != null ? { i: Math.min(scIdx, events.length - 1), at: events[Math.min(scIdx, events.length - 1)]!.at, ev: events[Math.min(scIdx, events.length - 1)]! } : null;
  // leaving a work order resets the scrub
  useEffect(() => () => setScrub(wo.id, null), [wo.id]);
  const route = wo.route;
  let scStation: string | null = null;
  if (sc) {
    wo.history.forEach((e) => {
      if (e.startedAt <= sc.at) scStation = e.station;
    });
    if (sc.ev.station) scStation = sc.ev.station;
    if (sc.ev.gate && gateDef(cat, sc.ev.gate)) scStation = gateDef(cat, sc.ev.gate)!.after;
  }
  const oe = openEntry(wo);
  const fl = flowOf(cat, project);
  const rows = fl.stations.map((st, idx) => {
    const allVisits = wo.history.filter((e) => e.station === st.id);
    const visits = sc ? allVisits.filter((e) => e.startedAt <= sc.at) : allVisits;
    const future = !!sc && allVisits.length > visits.length && !visits.length;
    const onRoute = route.includes(st.id);
    const cur = wo.station === cat.stations.findIndex((s) => s.id === st.id) && !wo.bay && wo.state !== "done";
    const g = gateAfter(cat, st.id);
    const gs = g ? wo.gates[g.id] : undefined;
    let kind = visits.length ? (cur && oe && !oe.endedAt ? "now" : "past") : "next";
    if (cur && wo.state === "waiting") kind = "now";
    if (sc) kind = st.id === scStation ? "now" : visits.length ? "past" : "next";
    const ag = agents.find((a) => a.id === st.agent);
    const body: ReactElement[] = [];
    if (!onRoute) body.push(<div key="skip" className="trv-line muted small">{project.flow.stations[st.id]?.enabled ? `Skipped by the ${cat.classes.find((c) => c.id === wo.cls)?.name ?? wo.cls} route` : `Off in ${project.name}`}</div>);
    else if (!visits.length)
      body.push(
        <div key="nr" className="trv-line">
          <Avatar id={st.agent} size="sm" />
          <span className="trv-agent">{ag?.name ?? name(st.agent)}</span>
          <span className="mono muted small">{ag?.model ?? ""}</span>
          <span className="trv-status muted">{future ? "not reached yet at this step" : "not reached"}</span>
        </div>,
      );
    visits.forEach((e, vi) => {
      const a = agents.find((x) => x.id === e.agent) ?? ag;
      const skills = (e.skills ?? []).map((s) => `${s.name} ${s.v}`);
      const live = !e.endedAt || (!!sc && e.endedAt > sc.at);
      body.push(
        <div key={`v${vi}`} className={`trv-visit${vi < visits.length - 1 ? " is-old" : ""}`}>
          <div className="trv-line">
            <Avatar id={e.agent} size="sm" />
            <span className="trv-agent">{name(e.agent)}</span>
            <span className="mono muted small">{`${e.model}${a ? ` · v${a.version}` : ""}`}</span>
            {live && cur ? <StateChip state={wo.state} /> : <span className={`trv-status${e.outcome && e.outcome !== "passed" ? " warn-text" : " muted"}`}>{e.outcome || (live ? "open" : "passed")}</span>}
            {visits.length > 1 ? <span className="chip">{`visit ${vi + 1}`}</span> : null}
          </div>
          <div className="trv-metrics mono">
            <span>{fmt.dur((e.endedAt || Date.now()) - e.startedAt)}</span>
            <span>{`${fmt.k(e.tokens)} tok`}</span>
            <span>{fmt.money(e.cost)}</span>
            <span className="muted">{`${fmt.ist(e.startedAt)}${e.endedAt ? `–${fmt.ist(e.endedAt)}` : ""} IST`}</span>
          </div>
          {skills.length ? <div className="trv-skills small muted">{`Skills: ${skills.join(", ")}`}</div> : null}
          {e.note && e.note !== "done" ? <div className="small">{`Note: ${e.note}`}</div> : null}
        </div>,
      );
    });
    if (g && gs && gs.status !== "pending" && !project.flow.gates[g.id]?.absent) {
      const dec = gs.decision;
      const late = !!sc && (dec ? dec.at > sc.at : !visits.length);
      const prog = gs.status === "waiting" && gateKind(cat, project, g.id) !== "auto" ? wo.gateProgress?.[g.id] : null;
      const gl: ReactElement[] = [];
      gs.checks.forEach((c, k) => gl.push(<li key={`c${k}`} className={c.ok ? "ok" : "bad"}><Icon name={c.ok ? "check" : "x"} /><span>{c.name}</span></li>));
      gs.approvals.forEach((a, k) =>
        gl.push(
          <li key={`a${k}`} className="ok">
            <Icon name="check" />
            <span>{`${g.id === "G6" ? "Release confirmed by " : "Approved by "}${name(a.by)} · ${fmt.stamp(a.at)}${a.via && a.via !== "web" ? ` · via ${a.via}` : ""}`}</span>
            {(a as { trust?: number | null }).trust != null ? trustTag((a as unknown as { trust: number }).trust, "cell at ") : null}
          </li>,
        ),
      );
      gs.rejections.forEach((a, k) => gl.push(<li key={`r${k}`} className="bad"><Icon name="x" /><span>{`Rejected by ${name(a.by)} · ${fmt.stamp(a.at)}: ${a.reason}`}</span></li>));
      if (dec && dec.mode === "trust")
        gl.push(<li key="dt" className="ok trv-dec-trust"><Icon name="trust" /><span>{`Passed under trust, no person needed · ${fmt.stamp(dec.at)}${dec.reason ? `. ${dec.reason}` : ""}`}</span>{dec.trust != null ? trustTag(dec.trust) : null}</li>);
      else if (dec && dec.mode === "auto") gl.push(<li key="da" className="ok"><Icon name="check" /><span>{`Passed automatically on checks · ${fmt.stamp(dec.at)}`}</span></li>);
      else if (dec && dec.mode === "human" && !gs.approvals.length)
        gl.push(<li key="dh" className="ok trv-dec-human"><Icon name="human" /><span>{`Decided by ${dec.by ? name(dec.by) : "a person"}${dec.via && dec.via !== "web" ? ` via ${dec.via}` : ""}`}</span></li>);
      if (gs.status === "waiting" && gs.trustNote) gl.push(<li key="tn" className="warn"><Icon name="trust" /><span>{`Why trust did not pass it: ${gs.trustNote}`}</span></li>);
      body.push(
        <div key="gate" className={`trv-gate trv-gate-${gs.status}${late ? " trv-future" : ""}`}>
          <span className="trv-gd" aria-hidden="true" />
          <div>
            <strong>{`${g.label} ${gs.status === "passed" && !late ? g.name : gatePendingName(g)}: ${late ? "not decided yet at this step" : gs.status === "waiting" ? `waiting${prog ? ` (${prog.have} of ${prog.need})` : ""}` : gs.status}`}</strong>
            {dec && !late ? <span className={`trv-mode trv-mode-${dec.mode}`}>{dec.mode === "trust" ? "under trust" : dec.mode === "auto" ? "automatic" : "by a person"}</span> : null}
            {prog && prog.unmet.length ? <div className="small">{`Still needs: ${prog.unmet.map((c) => c.text).join("; ")}`}</div> : null}
            {gl.length && !late ? <ul className="checklist small">{gl}</ul> : null}
          </div>
        </div>,
      );
    }
    return (
      <li key={st.id} className={`trv-row trv-${kind}${onRoute ? "" : " trv-skip"}${cur && !sc ? " trv-cur" : ""}${sc && st.id === scStation ? " trv-scrub-at" : ""}${sc && !visits.length && onRoute ? " trv-future" : ""}`}>
        <div className="trv-no">
          <span className="mono">{st.no}</span>
          <span className="trv-name">{st.name}</span>
        </div>
        <div className="trv-body">{body}</div>
      </li>
    );
    void idx;
  });
  const tot = woTotals(wo);
  return (
    <div>
      <Scrubber wo={wo} events={events} sc={scIdx} cat={cat} />
      {wo.bay ? (
        <div className="callout trv-baynote">
          <Icon name="st-park" />
          <span>{`Off the belt in ${bayLabel(cat, wo.bay)} since ${fmt.stamp(wo.bayAt || Date.now())}${wo.bayReason ? `: ${wo.bayReason}` : ""}. Returns to ${stName(cat, wo.bayFrom || cat.stations[wo.station]?.id)}.`}</span>
        </div>
      ) : null}
      <ol className="trv">{rows}</ol>
      <div className="trv-total mono">
        <span>Total</span>
        <span>{fmt.dur((wo.doneAt || wo.killed?.at || Date.now()) - wo.createdAt)}</span>
        <span>{`${fmt.k(tot.tokens)} tok`}</span>
        <span>{fmt.money(tot.cost)}</span>
      </div>
      <Outcomes wo={wo} />
    </div>
  );
}
