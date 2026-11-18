/** The Repo overrides, Delivery log and Card templates tabs (legacy overridesTab, deliveriesTab, templatesTab). */
import { useState } from "react";
import { Async } from "../../ui/async";
import { type Delivery, type Project } from "@gantry/domain";
import { useCan } from "../../api/can";
import { useDeliveries } from "../../api/queries";
import { ops } from "../../api/ops";
import { Btn, Empty, LockNote, Panel, type Decision } from "../../ui/primitives";
import { ListView, ago } from "../connect/kit";
import { hashFor } from "../../lib/router";
import { useUI } from "../../ui/overlay-context";
import { useOpenTraveler } from "../../shell/useTraveler";
import { useProjectRepos } from "../floor/kit";
import { ACTION_LABEL, ALL_FIELDS, KIND_EVENT, usePreview, type useNtData } from "./kit";

type Nt = ReturnType<typeof useNtData>;
const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

/* ---------- repo overrides ---------- */

/** The prototype's one list: each repo override as a link to the repo (its onboarding page, the repo dossier of this app), where it goes, and whether it is added to the routes or replaces them. */
export function OverridesTab({ p, nt }: { p: Project; nt: Nt }) {
  const repos = useProjectRepos(p.id);
  const rows = repos.flatMap((r) => (r.notifyOverrides ?? []).map((x, i) => ({ repo: r, o: x, i })));
  return (
    <Panel title="Repos that change the routes" flush id="nt-overrides">
      {rows.length ? (
        <ul className="list">
          {rows.map((x) => (
            <li key={`${x.repo.id}-${x.i}`}>
              <a className="pri" href={hashFor("dossier", x.repo.id, p.id)}>{x.repo.name}</a>
              <div className="grow small muted">{x.o.event} → {(x.o.dest ?? []).map((dd) => `${nt.instOf(dd)?.type ?? dd.channel} ${dd.target}`).join(", ")}</div>
              <span className="chip info">{x.o.mode === "instead" ? "instead" : "also"}</span>
            </li>
          ))}
        </ul>
      ) : <Empty title="No overrides" text="Repos use the project routes." />}
    </Panel>
  );
}

/* ---------- delivery log ---------- */

export function DeliveriesTab({ p, nt }: { p: Project; nt: Nt }) {
  const ui = useUI();
  const openTraveler = useOpenTraveler();
  const perm = dec(useCan("notify.edit", { project: p.id }));
  const [limit, setLimit] = useState(200);
  // the log is across every project (as in the prototype); retries are checked against the delivery's own project by the server
  const q = useDeliveries({ limit });
  const page = Array.isArray(q.data) ? { items: q.data, next: null } : q.data ?? { items: [] as Delivery[], next: null };
  const list = page.items;
  const retry = async (d: Delivery) => {
    const r = await ops.retryDelivery(d.id);
    ui.toast(r.ok ? "Delivered on retry" : r.msg, r.ok ? "ok" : "error");
  };
  const tone = (s: string): string => (s === "delivered" ? "ok" : s === "failed" ? "bad" : "warn");
  return (
    <div className="stack">
      <Async query={q} what="the delivery log" id="nt-dl">{() => (
        <Panel title="Deliveries" flush id="nt-deliveries">
          <ListView<Delivery>
            id="dlv" noun="delivery" rows={list} rowKey={(d) => d.id} rowId={(d) => `nt-dl-${d.id}`}
            text={(d) => `${d.event} ${d.target} ${d.channel} ${nt.projects.find((x) => x.id === d.project)?.name ?? d.project ?? ""}`}
            filters={[
              { key: "status", label: "Status", options: ["delivered", "failed", "pending"] },
              { key: "channel", label: "Channel", options: ["slack", "email", "teams", "webhook", "paging"] },
            ]}
            columns={[
              { key: "id", label: "Id", render: (d) => <span className="mono">{d.id}{d.test ? <span className="tag nt-testtag">test</span> : null}</span> },
              { key: "at", label: "When", sort: (d) => d.at, render: (d) => ago(d.at) },
              { key: "event", label: "Event", render: (d) => (
                <div>{d.event}{d.wo ? <span className="sub"><button type="button" className="linkish mono" id={`nt-dl-wo-${d.id}`} onClick={() => openTraveler(d.wo!)}>{d.wo}</button></span> : null}</div>
              ) },
              { key: "to", label: "To", render: (d) => `${d.channel} \u00b7 ${d.target}` },
              { key: "project", label: "Project", render: (d) => nt.projects.find((x) => x.id === d.project)?.name ?? d.project ?? "\u2014" },
              { key: "status", label: "Status", render: (d) => (
                <span className={`chip ${tone(d.status)}`} title={d.status !== "delivered" && (d.error || d.attempts) ? `${d.attempts ? `${d.attempts} ${d.attempts === 1 ? "try" : "tries"}` : ""}${d.error ? ` \u00b7 ${d.error}` : ""}` : undefined}>{d.status}</span>
              ) },
              { key: "a", label: "", align: "end", render: (d) => (d.status !== "delivered" ? <Btn label="Retry" small id={`nt-retry-${d.id}`} guard={perm} onClick={() => void retry(d)} /> : <span className="muted">{"\u2014"}</span>) },
            ]}
          />
        </Panel>
      )}</Async>
      {page.next ? <div className="more"><Btn label="Show more" id="nt-dl-more" onClick={() => setLimit(limit + 200)} /></div> : null}
      <LockNote decision={perm} what={`Retries on ${p.name}`} />
    </div>
  );
}

/* ---------- card templates tab: the three built-in cards as the server draws them, then the custom-card editor ---------- */

const PREVIEW_KINDS: Array<[string, string]> = [["gate", "Gate card"], ["question", "Question card"], ["release", "Release card"]];

function CardPreview({ p, kind, title }: { p: Project; kind: string; title: string }) {
  const q = usePreview(p.id, { event: KIND_EVENT[kind] ?? kind, template: kind, fields: { ...ALL_FIELDS } });
  const s = q.data?.sample;
  // the cards are drawn as a Slack message (the prototype's preview): the project's first Slack destination, then any destination
  const dests = p.notifications.flatMap((r) => r.dest);
  const target = (dests.find((d) => d.channel === "slack") ?? dests[0])?.target;
  const acts = (q.data?.actions ?? []).filter((a) => a !== "reject");
  return (
    <Panel title={title} id={`nt-card-${kind}`}>
      {s ? (
        <div className="card">
          {target ? <div className="micro">{target}</div> : null}
          <b>{s.head}</b>
          <div className="small muted">{s.project.name} · {s.prio} · {s.clsName}</div>
          <div className="row">{acts.map((a, i) => <span key={a} className={`chip ${i === 0 ? "ok" : "info"}`}>{a === "open" ? "Open" : ACTION_LABEL[a] ?? a}</span>)}</div>
        </div>
      ) : <p className="muted small">{q.isError ? "The preview could not be drawn." : "Drawing the preview…"}</p>}
    </Panel>
  );
}

export function CardsTab({ p }: { p: Project }) {
  return <div className="cols w3" id="nt-card-previews">{PREVIEW_KINDS.map(([k, t]) => <CardPreview key={k} p={p} kind={k} title={t} />)}</div>;
}
