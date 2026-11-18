import { useState } from "react";
import type { Project, Role, Team } from "@gantry/domain";
import { ops } from "../../api/ops";
import { getPrefs } from "../../lib/prefs";
import { useUI } from "../../ui/overlay-context";
import { DirtyMark } from "../../ui/DirtyMark";
import { Field, LockNote, Select, type Decision } from "../../ui/primitives";

/** The invite form (legacy G.inviteDialog). Sends POST /invites; the email goes out through the outbox. */
export function InviteForm({ perm, teams, projects, roles, domains, preset, close, onDone, registerSubmit }: {
  perm: Decision;
  teams: Team[];
  projects: Project[];
  roles: Role[];
  domains: string[];
  preset: { team?: string; project?: string };
  close: () => void;
  onDone: (personId: string) => void;
  registerSubmit: (fn: () => void) => void;
}) {
  const ui = useUI();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [team, setTeam] = useState(preset.team ?? teams[0]?.id ?? "");
  const [role, setRole] = useState(roles.some((r) => r.id === "engineer") ? "engineer" : roles[0]?.id ?? "");
  // The prototype form has no project field: a project role applies to the project you are working in (or the one the invite was opened from).
  const proj = preset.project ?? (projects.find((p) => p.id === getPrefs().project && p.status !== "archived") ?? projects.find((p) => p.status !== "archived"))?.id ?? "";
  const [reason, setReason] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const picked = roles.find((r) => r.id === role);
  const factoryLevel = picked?.level === "factory";

  registerSubmit(() => {
    void (async () => {
      const e = email.trim().toLowerCase();
      const dom = e.split("@")[1] ?? "";
      const bad: Record<string, string> = {};
      if (name.trim().length < 3) bad.name = "Full name is required";
      if (!e) bad.email = "Work email is required";
      else if (!/^[^@\s]+@[^@\s]+$/.test(e) || (domains.length && !domains.includes(dom))) bad.email = `Use an ${domains[0] ?? "acme.dev"} address (allowed domain).`;
      if (!role) bad.role = "Role is required";
      if (factoryLevel && reason.trim().length < 10) bad.reason = "Give a reason of at least 10 characters for the factory role.";
      setErrs(bad);
      if (Object.keys(bad).length) return;
      const rs: Array<{ role: string; scope: string }> = factoryLevel ? [{ role, scope: "factory" }] : proj ? [{ role, scope: proj }] : [];
      const r = await ops.invite({ name: name.trim(), email: e, teams: team ? [team] : [], roles: rs, ...(factoryLevel ? { reason: reason.trim() } : {}) });
      if (!r.ok) {
        ui.toast(r.msg, "error");
        setErr(r.msg);
        return;
      }
      ui.toast(`Invited ${name.trim()}`, "ok");
      // Close first: a reply without the person (the list refetches anyway) must never leave the dialog open.
      close();
      onDone((r as { person?: { id?: string } }).person?.id ?? "");
    })();
  });

  return (
    <div className="form-grid">
      <DirtyMark dirty={Boolean(name.trim() || email.trim() || reason.trim())} />
      <LockNote decision={perm} what="Inviting people" />
      <Field label="Full name" htmlFor="ppl-inv-name" required error={errs.name}>
        <input id="ppl-inv-name" className="input" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Work email" htmlFor="ppl-inv-email" required error={errs.email}>
        <input id="ppl-inv-email" className="input" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Role" htmlFor="ppl-inv-prole" error={errs.role}>
        <Select id="ppl-inv-prole" value={role} onChange={setRole} options={roles.map((r) => ({ value: r.id, label: r.name + (r.custom ? " (custom)" : "") }))} />
      </Field>
      <Field label="Team" htmlFor="ppl-inv-team">
        <Select id="ppl-inv-team" value={team} onChange={setTeam} options={[...teams.map((t) => ({ value: t.id, label: t.name }))]} />
      </Field>
      {factoryLevel ? (
        <Field label="Reason for the factory role" htmlFor="ppl-inv-reason" required error={errs.reason} hint="Recorded in the audit trail. Factory roles need a fresh sign-in.">
          <input id="ppl-inv-reason" className="input" autoComplete="off" placeholder="Why this person needs it" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      ) : null}
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}

export function useInviteDialog(args: { perm: Decision; teams: Team[]; projects: Project[]; roles: Role[]; domains: string[]; onDone: (id: string) => void }) {
  const ui = useUI();
  return (preset: { team?: string; project?: string } = {}) => {
    let submit: () => void = () => undefined;
    ui.dialog({
      title: "Invite a person",
      body: (close) => <InviteForm {...args} preset={preset} close={close} registerSubmit={(fn) => (submit = fn)} />,
      actions: [{ label: "Cancel" }, { label: "Send invite", kind: "primary", icon: "send", submit: true, id: "ppl-inv-submit", guard: args.perm, onClick: () => submit() }],
    });
  };
}
