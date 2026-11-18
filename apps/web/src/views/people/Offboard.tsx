import { qk } from "../../api/keys";
import { useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Person, Project, WorkOrder } from "@gantry/domain";
import { api, get } from "../../api/client";
import { ops, type OpenWorkItem } from "../../api/ops";
import { useApiKeys } from "../../api/queries";
import type { Page } from "../../api/types";
import { hashFor } from "../../lib/router";
import { useUI } from "../../ui/overlay-context";
import { Icon } from "../../ui/Icon";
import { Field, LockNote, type Decision } from "../../ui/primitives";
import { usePeopleLoad } from "../govern/load";
import { useOutcome } from "../govern/data";

type OpenWork = OpenWorkItem & { why?: string };

const MIN_REASON = 10;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isOpen = (w: WorkOrder) => w.state !== "done" && w.state !== "killed";

/** Open work the person requested, or where they are the only named approver of a waiting gate, among the work this viewer can see. Only a preview: the server counts requester, assignee and sole approver across everything and returns the real list. */
export function previewWork(p: Person, projects: Project[], lists: Array<WorkOrder[] | undefined>): OpenWork[] {
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

/** What this person holds and what deactivating does to each, then the reason. On success it lists the work left open so an admin can reassign. */
export function DeactivateForm({ p, projects, perm, onDone, registerSubmit }: {
  p: Person; projects: Project[]; perm: Decision; onDone: (r: { keep: boolean; work: OpenWork[] | null }) => void; registerSubmit: (fn: () => void) => void;
}) {
  const outcome = useOutcome();
  const keysQ = useApiKeys();
  const load = usePeopleLoad(projects);
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
  const keep = false; // keys are revoked, as the dialog says
  const [err, setErr] = useState("");
  const [rule, setRule] = useState("");
  const [busy, setBusy] = useState(false);

  const keys = (keysQ.data ?? []).filter((k) => k.by === p.id && !k.revoked && !k.expired);
  const work = previewWork(p, projects, lists.map((l) => l.data));

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

  const NA = "not available";
  const requested = projects.reduce((t, pr) => t + load.requested(p.id, pr.id), 0);
  const owned = projects.filter((x) => x.owner === p.id);
  const kv = (label: string, v: ReactNode) => <><dt>{label}</dt><dd>{v}</dd></>;
  const n = (x: number, unavailable: boolean) => (unavailable ? NA : String(x));
  return (
    <div className="form-grid" id="ppl-off">
      <LockNote decision={perm} what="Deactivating people" />
      <div className="grid g2">
        <dl className="kv" id="ppl-off-holds" style={{ margin: 0 }}>
          {kv("Open work orders", load.loading ? "…" : load.partial ? NA : `${requested} will be reassigned to the project owner`)}
          {kv("Pending approvals", load.loading ? "…" : load.partial ? NA : `${load.eligible(p.id)} lose this approver`)}
          {kv("API keys", keysQ.isError ? NA : `${n(keys.length, false)} revoked`)}
          {kv("Projects owned", owned.length ? `${owned.map((x) => x.name).join(", ")} need a new owner` : "none")}
        </dl>
        <div className="banner warn"><Icon name="alert" /><div className="grow">{`History stays attributed to ${p.name} in the audit ledger.`}</div></div>
      </div>
      <Field label="Reason" htmlFor="ppl-off-reason" required>
        <input id="ppl-off-reason" className="input" autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />
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
        title: `Deactivate ${p.name}?`, wide: true,
        sub: "They are signed out everywhere and cannot sign in.",
        body: (close) => <DeactivateForm p={p} projects={args.projects} perm={guard} registerSubmit={(fn) => (submit = fn)} onDone={(r) => {
          close();
          ui.dialog({
            title: `${p.name} is deactivated`, kicker: "People", wide: true,
            body: (c) => <DeactivatedResult p={p} keep={r.keep} work={r.work} projects={args.projects} onGo={c} />,
            actions: [{ label: "Close", kind: "primary", id: "ppl-off-close" }],
          });
        }} />,
        actions: [{ label: "Cancel" }, { label: "Deactivate", kind: "danger", submit: true, id: "ppl-off-submit", guard, onClick: () => submit() }],
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
