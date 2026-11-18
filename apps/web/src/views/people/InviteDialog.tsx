import { useState } from "react";
import type { Project, Role, Team } from "@gantry/domain";
import { ops } from "../../api/ops";
import { getPrefs } from "../../lib/prefs";
import { useUI } from "../../ui/overlay-context";
import { Field, LockNote, Select, type Decision } from "../../ui/primitives";
import { minLen, required, useFieldErrors } from "../govern/validate";

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
  const [team, setTeam] = useState(preset.team ?? teams.find((t) => t.name.toLowerCase() === "platform")?.id ?? teams[0]?.id ?? "");
  // The prototype asks only for a role and a team. A project role needs a project: the one open in the top bar (or the first live one).
  const live = projects.filter((p) => p.status !== "archived");
  const proj = preset.project ?? live.find((p) => p.id === getPrefs().project)?.id ?? live[0]?.id ?? "";
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const fe = useFieldErrors();
  const isFactory = roles.find((r) => r.id === role)?.level === "factory";

  registerSubmit(() => {
    void (async () => {
      const e = email.trim().toLowerCase();
      setErr("");
      const emailMsg = required("Work email", e) || (/^\S+@\S+\.\S+$/.test(e) ? "" : "Enter a valid email address.");
      if (!fe.run([["ppl-inv-name", required("Full name", name) || minLen("Full name", name, 3)], ["ppl-inv-email", emailMsg]])) return;
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
      <Field label="Full name (required)" htmlFor="ppl-inv-name" error={fe.errors["ppl-inv-name"]}>
        <input id="ppl-inv-name" className="input" aria-required="true" autoComplete="off" value={name} onChange={(e) => { setName(e.target.value); fe.clear("ppl-inv-name"); }} />
      </Field>
      <Field label="Work email (required)" htmlFor="ppl-inv-email" error={fe.errors["ppl-inv-email"]}>
        <input id="ppl-inv-email" className="input" type="email" aria-required="true" autoComplete="off" value={email} onChange={(e) => { setEmail(e.target.value); fe.clear("ppl-inv-email"); }} />
      </Field>
      <Field label="Title" htmlFor="ppl-inv-title">
        <input id="ppl-inv-title" className="input" autoComplete="off" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Role" htmlFor="ppl-inv-role">
        <Select id="ppl-inv-role" value={role} onChange={setRole} options={roles.map((r) => ({ value: r.id, label: r.name }))} />
      </Field>
      <Field label="Team" htmlFor="ppl-inv-team">
        <Select id="ppl-inv-team" value={team} onChange={setTeam} options={teams.map((t) => ({ value: t.id, label: t.name }))} />
      </Field>
      {isFactory ? (
        <Field label="Reason" htmlFor="ppl-inv-reason">
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
      title: "Invite a person",
      body: (close) => <InviteForm {...args} preset={preset} close={close} registerSubmit={(fn) => (submit = fn)} />,
      actions: [{ label: "Cancel" }, { label: "Send invite", kind: "primary", submit: true, id: "ppl-inv-submit", guard: args.perm, onClick: () => submit() }],
    });
  };
}
