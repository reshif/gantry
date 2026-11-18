import { qk } from "../../api/keys";
import { useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Person, Project, WorkOrder } from "@gantry/domain";
import { api, get } from "../../api/client";
import { ops, type OpenWorkItem } from "../../api/ops";
import { useApiKeys, useSessions } from "../../api/queries";
import type { Page } from "../../api/types";
import { hashFor } from "../../lib/router";
import { useUI } from "../../ui/overlay-context";
import { Icon } from "../../ui/Icon";
import { Field, LockNote, type Decision } from "../../ui/primitives";
import { useOutcome } from "../govern/data";

type OpenWork = OpenWorkItem & { why?: string };

const MIN_REASON = 10;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isOpen = (w: WorkOrder) => w.state !== "done" && w.state !== "killed";

/** Open work the person requested, or where they are the only named approver of a waiting gate, among the work this viewer can see. Only a preview: the server counts requester, assignee and sole approver across everything and returns the real list. */
function previewWork(p: Person, projects: Project[], lists: Array<WorkOrder[] | undefined>): OpenWork[] {
  const out: OpenWork[] = [];
  projects.forEach((pr, i) => {
    for (const w of lists[i] ?? []) {
      if (!isOpen(w)) continue;
      if (w.requestedBy === p.id) {
        out.push({ id: w.id, title: w.title, project: pr.id, state: w.state, why: "They requested it. Questions go unanswered." });
        continue;
      }
      const only = Object.entries(w.gates ?? {}).find(([g, gi]) => {
        const rule = pr.approvers?.[g];
        return gi.status === "waiting" && !!rule && rule.people.length === 1 && rule.people[0] === p.id && !rule.roles?.length;
      });
      if (only) out.push({ id: w.id, title: w.title, project: pr.id, state: w.state, why: `Only named approver of the ${only[0]} gate. It waits for someone else.` });
    }
  });
  return out;
}

const ROLE_WHY: Record<string, string> = {
  requester: "They requested it. Questions go unanswered.",
  assignee: "It is assigned to them. Nobody is working it.",
  sole_approver: "They are the only one who can approve the waiting gate.",
};
const whyOf = (w: OpenWork): string | undefined => w.why ?? (w.roles?.length ? w.roles.map((r) => (r === "sole_approver" && w.gate ? `Only approver of the ${w.gate} gate. It waits for someone else.` : ROLE_WHY[r] ?? r)).join(" ") : undefined);

function WorkList({ work, projects, onGo }: { work: OpenWork[]; projects: Project[]; onGo: () => void }) {
  return (
    <ul className="ppl-off-list" id="ppl-off-work">
      {work.map((w) => (
        <li key={w.id}>
          <span className="ppl-off-what"><a className="mono" href={hashFor("record", w.id, w.project ?? null)} onClick={onGo}>{w.id}</a>{w.title ? ` ${w.title}` : ""}</span>
          <span className="muted small">{[projects.find((x) => x.id === w.project)?.name ?? w.project, w.state, whyOf(w)].filter(Boolean).join(" · ")}</span>
        </li>
      ))}
    </ul>
  );
}

function Section({ title, count, empty, unavailable, children }: { title: string; count: number; empty: string; unavailable?: boolean; children?: ReactNode }) {
  return (
    <div className="ppl-off-sec">
      <div className="ppl-off-h"><span className="kicker">{title}</span><span className="mono muted small">{unavailable ? "?" : count}</span></div>
      {unavailable ? <span className="muted small">Not shown: your access does not cover this list. The server still applies it.</span> : count ? children : <span className="muted small">{empty}</span>}
    </div>
  );
}

/** What this person holds and what deactivating does to each, then the reason. On success it lists the work left open so an admin can reassign. */
export function DeactivateForm({ p, projects, roleName, perm, onDone, registerSubmit }: {
  p: Person; projects: Project[]; roleName: (id: string) => string; perm: Decision; onDone: (r: { keep: boolean; work: OpenWork[] | null }) => void; registerSubmit: (fn: () => void) => void;
}) {
  const outcome = useOutcome();
  const keysQ = useApiKeys();
  const sessQ = useSessions({ all: true });
  const lists = useQueries({
    queries: projects.map((pr) => ({
      queryKey: qk.workOrders(pr.id, { offboard: p.id }),
      queryFn: async () => {
        const r = await get<WorkOrder[] | Page<WorkOrder>>(api(`projects/${encodeURIComponent(pr.id)}/work-orders`), {});
        return Array.isArray(r) ? r : r.items;
      },
    })),
  });
  const [reason, setReason] = useState("");
  const [keep, setKeep] = useState(false);
  const [err, setErr] = useState("");
  const [rule, setRule] = useState("");
  const [busy, setBusy] = useState(false);

  const scopeName = (s: string) => (s === "factory" ? "Factory" : projects.find((x) => x.id === s)?.name ?? s);
  const oncall = projects.filter((x) => x.oncall?.includes(p.id));
  const keys = (keysQ.data ?? []).filter((k) => k.by === p.id && !k.revoked && !k.expired);
  const sessions = (sessQ.data ?? []).filter((s) => s.person === p.id && !s.revoked);
  const work = previewWork(p, projects, lists.map((l) => l.data));
  const workUnavailable = lists.some((l) => l.isError);
  const loadingWork = lists.some((l) => l.isLoading);

  registerSubmit(() => {
    if (busy) return;
    const text = reason.trim();
    if (text.length < MIN_REASON) return setErr(`Give a reason of at least ${MIN_REASON} characters.`);
    setErr("");
    setRule("");
    setBusy(true);
    void (async () => {
      // A fresh sign-in is asked for by the shared step-up flow inside the request.
      const r = await ops.deactivatePerson(p.id, text, keep, p.version !== undefined ? { ifMatch: p.version } : undefined);
      setBusy(false);
      if (!r.ok) {
        setErr(r.msg);
        setRule(r.rule ? `${r.rule.name ? `${r.rule.name} ` : ""}[${r.rule.id}]` : "");
        return;
      }
      outcome(r, `${p.name} is deactivated.`);
      onDone({ keep, work: r.openWork ?? null });
    })();
  });

  return (
    <div className="form-grid" id="ppl-off">
      <LockNote decision={perm} what="Deactivating people" />
      <div className="banner warn"><Icon name="alert" /><div className="grow">{`History stays attributed to ${p.name} in the audit ledger.`}</div></div>
      <Section title="Roles" count={p.roles.length} empty="No roles. Nothing to lose.">
        <ul className="ppl-off-list">
          {p.roles.map((g) => (
            <li key={`${g.role}-${g.scope}-${g.via ?? ""}`}>
              <span className="ppl-off-what">{`${roleName(g.role)} · ${scopeName(g.scope)}${g.via ? ` · via ${g.via}` : ""}`}</span>
              <span className="muted small">{g.via ? "Stays with the team; they can no longer use it." : "Their access ends."}</span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="On call" count={oncall.length} empty="Not on call for any project.">
        <ul className="ppl-off-list">
          {oncall.map((x) => <li key={x.id}><span className="ppl-off-what">{x.name}</span><span className="muted small">Choose a replacement in Project config.</span></li>)}
        </ul>
      </Section>
      <Section title="API keys they created" count={keys.length} empty="No live keys." unavailable={keysQ.isError}>
        <ul className="ppl-off-list">
          {keys.map((k) => <li key={k.id}><span className="ppl-off-what">{k.name} <span className="mono muted small">{k.prefix}</span></span><span className="muted small">{keep ? "Kept. Still works." : "Revoked. Anything using it stops."}</span></li>)}
        </ul>
        <label className="check" htmlFor="ppl-off-keep">
          <input id="ppl-off-keep" type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          Keep these keys working
        </label>
      </Section>
      <Section title="Active sessions" count={sessions.length} empty={sessQ.isLoading ? "Checking." : "None."} unavailable={sessQ.isError}>
        <span className="muted small">All end now. They sign in again if reactivated.</span>
      </Section>
      <Section title="Open work" count={work.length} empty={loadingWork ? "Checking." : "None found in the work you can see."} unavailable={workUnavailable && !work.length}>
        <WorkList work={work} projects={projects} onGo={() => undefined} />
        <span className="muted small">A preview from work you can see. The server checks all work, including assigned orders, and lists it afterwards.</span>
      </Section>
      <Field label="Reason" htmlFor="ppl-off-reason" hint={`Recorded on the audit log. At least ${MIN_REASON} characters. You may be asked to sign in again.`}>
        <textarea id="ppl-off-reason" className="input" rows={3} placeholder="Why is this person leaving?" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="form-err" role="alert" id="ppl-off-err">{err}{rule ? <span className="mono small">{` Rule ${rule}`}</span> : null}</div>
    </div>
  );
}

/** Shown after a successful deactivation: the server's list of work left open, each linked so an admin can reassign it. */
export function DeactivatedResult({ p, keep, work, projects, onGo }: { p: Person; keep: boolean; work: OpenWork[] | null; projects: Project[]; onGo: () => void }) {
  return (
    <div className="form-grid" id="ppl-off-done">
      <p className="ppl-off-ok"><Icon name="check" />{` ${p.name} is deactivated. Sessions ended; API keys ${keep ? "kept" : "revoked"}.`}</p>
      {work === null ? <p className="muted small">The server did not list their open work. Check the work orders they requested or were assigned.</p>
        : work.length ? (
          <>
            <p className="muted small">{`${plural(work.length, "work order")} still ${work.length === 1 ? "needs" : "need"} someone else. Open each to reassign it.`}</p>
            <WorkList work={work} projects={projects} onGo={onGo} />
          </>
        ) : <p className="muted small">They had no open work.</p>}
    </div>
  );
}

export function useOffboard(args: { perm: Decision; projects: Project[]; roleName: (id: string) => string }) {
  const ui = useUI();
  return {
    deactivate(p: Person, guard: Decision) {
      let submit: () => void = () => undefined;
      ui.dialog({
        title: `Deactivate ${p.name}?`, kicker: "People", wide: true,
        sub: "They are signed out everywhere and cannot sign in.",
        body: (close) => <DeactivateForm p={p} projects={args.projects} roleName={args.roleName} perm={guard} registerSubmit={(fn) => (submit = fn)} onDone={(r) => {
          close();
          ui.dialog({
            title: `${p.name} is deactivated`, kicker: "People", wide: true,
            body: (c) => <DeactivatedResult p={p} keep={r.keep} work={r.work} projects={args.projects} onGo={c} />,
            actions: [{ label: "Close", kind: "primary", id: "ppl-off-close" }],
          });
        }} />,
        actions: [{ label: "Close" }, { label: "Deactivate", kind: "danger", submit: true, id: "ppl-off-submit", guard, onClick: () => submit() }],
      });
    },
    reactivate(p: Person) {
      ui.reasonDialog({
        title: `Reactivate ${p.name}?`, kicker: "People",
        sub: "They can sign in again. Roles come back; API keys and sessions do not.",
        label: "Reason", placeholder: "Why are they back?", ok: "Reactivate", min: MIN_REASON, guard: args.perm,
        onOk: async (reason) => {
          const r = await ops.reactivatePerson(p.id, reason, p.version !== undefined ? { ifMatch: p.version } : undefined);
          if (!r.ok) return r;
          ui.toast(`${p.name} reactivated`, "ok");
          return { ok: true };
        },
      });
    },
  };
}
