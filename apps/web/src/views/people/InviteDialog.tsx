import { useState } from "react";
import type { Project, Role, Team } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useUI } from "../../ui/overlay-context";
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
  onDone: (personId: string, email: string) => void;
  registerSubmit: (fn: () => void) => void;
}) {
  const ui = useUI();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState(roles.find((r) => r.id === "engineer")?.id ?? roles[0]?.id ?? "");
  const [team, setTeam] = useState(preset.team ?? teams[0]?.id ?? "");
  const [proj, setProj] = useState(preset.project ?? projects.find((p) => p.status !== "archived")?.id ?? "");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const isFactory = roles.find((r) => r.id === role)?.level === "factory";

  registerSubmit(() => {
    void (async () => {
      const e = email.trim().toLowerCase();
      if (name.trim().length < 3) return setErr("Full name needs at least 3 characters.");
      if (!/^\S+@\S+\.\S+$/.test(e)) return setErr("Enter a work email.");
      const dom = e.split("@")[1];
      if (dom && domains.length && !domains.includes(dom)) return setErr(`${dom} is not an allowed domain. Add it in Security first.`);
      if (isFactory && reason.trim().length < 10) return setErr("Give a reason of at least 10 characters for the factory role.");
      if (!isFactory && !proj) return setErr("Pick the project this role applies to.");
      const rs = role ? [{ role, scope: isFactory ? "factory" : proj }] : [];
      const r = await ops.invite({ name: name.trim(), email: e, ...(title.trim() ? { title: title.trim() } : {}), teams: team ? [team] : [], roles: rs, ...(isFactory ? { reason: reason.trim() } : {}) });
      if (!r.ok) {
        const msg = r.status === 409 ? "That email already has an account" : r.msg;
        ui.toast(msg, "error");
        setErr(msg);
        return;
      }
      ui.toast(`Invite sent to ${e}`, "ok");
      onDone((r as unknown as { person?: { id: string } }).person?.id ?? "", e);
      close();
    })();
  });

  return (
    <div className="form-grid">
      <LockNote decision={perm} what="Inviting people" />
      <Field label="Full name" htmlFor="ppl-inv-name" required>
        <input id="ppl-inv-name" className="input" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Work email" htmlFor="ppl-inv-email" required hint={domains.length ? `Must use an allowed domain: ${domains.join(", ")}` : undefined}>
        <input id="ppl-inv-email" className="input" type="email" autoComplete="off" placeholder={`name@${domains[0] ?? "acme.dev"}`} value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Title" htmlFor="ppl-inv-title">
        <input id="ppl-inv-title" className="input" autoComplete="off" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Role" htmlFor="ppl-inv-role">
        <Select id="ppl-inv-role" value={role} onChange={setRole} options={roles.map((r) => ({ value: r.id, label: r.name + (r.custom ? " (custom)" : "") }))} />
      </Field>
      <Field label="Team" htmlFor="ppl-inv-team">
        <Select id="ppl-inv-team" value={team} onChange={setTeam} options={teams.map((t) => ({ value: t.id, label: t.name }))} />
      </Field>
      {role && !isFactory ? (
        <Field label="Project" htmlFor="ppl-inv-proj" hint="A project role applies in one project.">
          <Select id="ppl-inv-proj" value={proj} onChange={setProj} options={projects.filter((p) => p.status !== "archived").map((p) => ({ value: p.id, label: p.name }))} />
        </Field>
      ) : null}
      {isFactory ? (
        <Field label="Reason for the factory role" htmlFor="ppl-inv-reason" hint="Recorded in the audit trail. Factory roles need a fresh sign-in.">
          <input id="ppl-inv-reason" className="input" autoComplete="off" placeholder="Why this person needs it" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      ) : null}
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}

export function useInviteDialog(args: { perm: Decision; teams: Team[]; projects: Project[]; roles: Role[]; domains: string[]; onDone: (id: string, email: string) => void }) {
  const ui = useUI();
  return (preset: { team?: string; project?: string } = {}) => {
    let submit: () => void = () => undefined;
    ui.dialog({
      title: "Invite a person", kicker: "People", wide: true,
      sub: "They get an email with a sign-in link. Until they accept, the policy engine grants them nothing.",
      body: (close) => <InviteForm {...args} preset={preset} close={close} registerSubmit={(fn) => (submit = fn)} />,
      actions: [{ label: "Cancel" }, { label: "Send invite", kind: "primary", submit: true, id: "ppl-inv-submit", guard: args.perm, onClick: () => submit() }],
    });
  };
}
