import { useState } from "react";
import { fmt } from "@gantry/domain";
import { Btn, Empty, Panel } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useOpenTraveler } from "../../shell/useTraveler";
import { useMe } from "../../api/queries";
import { canSeeRoute } from "../../lib/routes";
import { goProject } from "../projects/kit";
import { goAttention, STAGE_NAME, type AttentionItem, type HomeFull } from "./data";
import type { AuditRow } from "../audit/data";

const SEV = [{ id: "crit", label: "Critical" }, { id: "high", label: "High" }, { id: "watch", label: "Watch" }] as const;

export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  const [all, setAll] = useState(false);
  const openTraveler = useOpenTraveler();
  const limit = all ? items.length : 8;
  const counts = SEV.map((_, i) => items.filter((x) => x.sev === i).length);
  return (
    <Panel title="Needs attention" cls="hm-att-panel" tools={<span className="mono small muted">{items.length + " open"}</span>}>
      {items.length ? (
        <div>
          <p className="hm-att-sum small">
            {SEV.map((s, i) => (
              <span key={s.id} className={`hm-sev hm-sev-${s.id}`}>
                <span className="hm-sev-mark" aria-hidden="true" />
                {counts[i] + " " + s.label.toLowerCase()}
              </span>
            ))}
          </p>
          <ol className="hm-att">
            {items.slice(0, limit).map((x) => {
              const s = SEV[x.sev];
              return (
                <li key={x.id} className={`hm-att-item hm-sev-${s.id}`}>
                  <span className="hm-att-ic" title={s.label}><Icon name={x.icon} /></span>
                  <div className="hm-att-main">
                    <div className="hm-att-t"><span className="sr">{s.label + ": "}</span>{x.title}</div>
                    <div className="muted small hm-att-w">{x.where + " · " + x.sub}</div>
                  </div>
                  <Btn label={x.act.label} small kind="ghost" id={x.id} aria={`${x.act.label} for ${x.title}`} onClick={() => goAttention(x.act, openTraveler)} />
                </li>
              );
            })}
          </ol>
          {items.length > 8 ? <Btn label={all ? "Show the top 8" : `Show all ${items.length}`} small kind="ghost" id="hm-att-more" onClick={() => setAll(!all)} /> : null}
        </div>
      ) : (
        <Empty title="Nothing needs attention" text="Blocked work, gates past SLA, failing onboarding, eval regressions, vendor incidents, budget overruns, security holds and kills appear here." />
      )}
    </Panel>
  );
}

const CAT_IC: Record<string, string> = { kill: "st-kill", approvals: "diamond", flow: "belt", onboarding: "rocket", auth: "user", access: "lock", config: "filter", integrations: "plug", api: "api", agents: "agent" };

export function ActivityPanel({ items, projectName }: { items: AuditRow[]; projectName: (id: string) => string }) {
  const me = useMe();
  const audit = !!me && canSeeRoute("audit", me, {});
  return (
    <Panel title="Live activity" cls="hm-act-panel" tools={audit ? <a href="#audit" className="linkish small" id="hm-audit-link">Audit ledger</a> : null}>
      {items.length ? (
        <ol className="hm-act" data-keep-scroll="hm-act" tabIndex={0} aria-label="Latest audit entries">
          {items.map((e) => (
            <li key={e.seq} className={`hm-act-item hm-act-${e.category}`}>
              <span className="hm-act-ic"><Icon name={CAT_IC[e.category] ?? "dots"} /></span>
              <div className="hm-act-main">
                <div>
                  <strong>{e.actorName.replace(" (agent)", "")}</strong>{" "}
                  <span className="mono small">{e.action}</span>{" "}
                  <span>{e.target}</span>
                </div>
                <div className="small muted">{fmt.ago(e.at, Date.now()) + (e.project ? " · " + projectName(e.project) : "") + " · via " + (e.via || "web")}</div>
              </div>
              {e.outcome !== "ok" ? <span className={`outcome o-${e.outcome}`}>{e.outcome}</span> : null}
            </li>
          ))}
        </ol>
      ) : (
        <Empty title="No activity yet" text="Every change, approval and sign-in appears here as it happens." />
      )}
    </Panel>
  );
}

export function OnboardingPanel({ data, projectName }: { data: NonNullable<HomeFull["onboarding"]>; projectName: (id: string) => string }) {
  return (
    <Panel title="Onboarding pipeline" tools={<span className="mono small muted">{`${data.ready} of ${data.total} ready`}</span>}>
      <div>
        <ol className="hm-pipe" aria-label="Repos per onboarding stage">
          {data.stages.map((s) => (
            <li key={s.id} className={`hm-pipe-st${s.count ? " has" : ""}${s.id === "ready" ? " is-ready" : ""}`}>
              <span className="hm-pipe-n">{String(s.count)}</span>
              <span className="hm-pipe-l">{STAGE_NAME[s.id] ?? s.name}</span>
            </li>
          ))}
        </ol>
        {data.stuck.length ? (
          <p className="hm-pipe-stuck small">
            <Icon name="alert" />
            {`${data.stuck.length} stuck: ` + data.stuck.map((r) => `${r.name} (${STAGE_NAME[r.stage] ?? r.stage})`).join(", ")}
          </p>
        ) : null}
        {data.open.length ? (
          <ul className="hm-pipe-list">
            {data.open.map((r) => (
              <li key={r.repo}>
                <button type="button" className="linkish mono" id={`hm-pipe-${r.repo}`} onClick={() => goProject(r.project, "onboarding")}>{r.name}</button>
                <span className="muted small">{`${projectName(r.project)} · ${STAGE_NAME[r.stage] ?? r.stage}`}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">{data.total ? "Every repo is Ready." : "No repos are connected yet."}</p>
        )}
      </div>
    </Panel>
  );
}

function Bars({ rows, idp }: { rows: Array<{ id: string; label: string; v: number; b: number; alert?: number }>; idp: string }) {
  const max = Math.max(...rows.map((r) => Math.max(r.v, r.b)), 0) || 1;
  if (!rows.length) return <p className="muted small">None yet.</p>;
  return (
    <ul className="hm-bars">
      {rows.map((r) => {
        const ratio = r.b ? r.v / r.b : 0;
        const tone = r.b && ratio >= 1 ? "over" : r.b && ratio >= (r.alert || 0.85) ? "warn" : "ok";
        const tip = `${r.label}: ${fmt.money0(r.v)}${r.b ? ` of ${fmt.money0(r.b)} budget (${fmt.pct(ratio)})` : ", no budget set"}`;
        return (
          <li key={r.id} className={`hm-bar-row is-${tone}`} id={idp + r.id} tabIndex={0} data-tip={tip} aria-label={tip}>
            <span className="hm-bar-l">{r.label}</span>
            <span className="hm-bar-track" aria-hidden="true">
              <span className="hm-bar-fill" style={{ width: `${((r.v / max) * 100).toFixed(1)}%` }} />
              {r.b ? <span className="hm-bar-budget" style={{ left: `${((r.b / max) * 100).toFixed(1)}%` }} /> : null}
            </span>
            <span className="hm-bar-v mono">
              {tone !== "ok" ? <Icon name="alert" /> : null}
              {fmt.money0(r.v)}
              <span className="muted">{r.b ? " / " + fmt.money0(r.b) : ""}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function SpendPanel({ data }: { data: NonNullable<HomeFull["spend"]> }) {
  const sum = (a: Array<{ v: number }>) => a.reduce((n, x) => n + x.v, 0);
  const bud = (a: Array<{ b: number }>) => a.reduce((n, x) => n + x.b, 0);
  return (
    <Panel title="Spend this month" cls="hm-spend-panel">
      <div className="hm-spend">
        <div>
          <div className="sub-h">{`By project · ${fmt.money0(sum(data.projects))} of ${fmt.money0(bud(data.projects))}`}</div>
          <Bars rows={data.projects} idp="hm-sp-" />
        </div>
        <div>
          <div className="sub-h">{`By vendor · ${fmt.money0(sum(data.vendors))} of ${fmt.money0(bud(data.vendors))}`}</div>
          <Bars rows={data.vendors} idp="hm-sv-" />
        </div>
        <p className="hm-bars-key small muted">
          <span className="hm-key-fill" aria-hidden="true" />{"spent  "}<span className="hm-key-budget" aria-hidden="true" />{"budget  "}<Icon name="alert" />{"at or over the alert line"}
        </p>
      </div>
    </Panel>
  );
}

