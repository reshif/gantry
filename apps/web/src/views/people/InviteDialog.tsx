import { useState } from "react";
import type { Project, Role, Team } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useUI } from "../../ui/overlay-context";
import { Field, LockNote, Select, type Decision } from "../../ui/primitives";
import { useOutcome } from "../govern/data";

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
  const outcome = useOutcome();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [picked, setPicked] = useState<string[]>(preset.team ? [preset.team] : []);
  const factoryRoles = roles.filter((r) => r.level === "factory");
  const projectRoles = roles.filter((r) => r.level !== "factory");
  const [fRole, setFRole] = useState("");
  const [proj, setProj] = useState(preset.project ?? "");
  const [pRole, setPRole] = useState("engineer");
  const [err, setErr] = useState("");

  registerSubmit(() => {
    void (async () => {
      const e = email.trim().toLowerCase();
      const dom = e.split("@")[1];
      if (dom && domains.length && !domains.includes(dom)) return setErr(`${dom} is not an allowed domain. Add it in Security first.`);
      const rs: Array<{ role: string; scope: string }> = [];
      if (fRole) rs.push({ role: fRole, scope: "factory" });
      if (proj) rs.push({ role: pRole, scope: proj });
      const r = await ops.invite({ name, email: e, teams: picked, roles: rs });
      outcome(r);
      if (!r.ok) {
        setErr(r.msg);
        return;
      }
      onDone((r as unknown as { person: { id: string } }).person.id);
      close();
    })();
  });

  return (
    <div className="form-grid">
      <LockNote decision={perm} what="Inviting people" />
      <div className="form-row">
        <Field label="Name" htmlFor="ppl-inv-name">
          <input id="ppl-inv-name" className="input" autoComplete="off" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Work email" htmlFor="ppl-inv-email" hint={domains.length ? `Must use an allowed domain: ${domains.join(", ")}` : undefined}>
          <input id="ppl-inv-email" className="input" type="email" autoComplete="off" placeholder={`name@${domains[0] ?? "acme.dev"}`} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
      <div className="field">
        <div className="field-label">Teams</div>
        <div className="check-grid">
          {teams.map((t) => (
            <label key={t.id} className="check" htmlFor={`ppl-inv-t-${t.id}`}>
              <input type="checkbox" id={`ppl-inv-t-${t.id}`} value={t.id} checked={picked.includes(t.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, t.id] : picked.filter((x) => x !== t.id))} />
              {t.name}
            </label>
          ))}
        </div>
      </div>
      <div className="form-row">
        <Field label="Factory role" htmlFor="ppl-inv-frole" hint="Factory roles apply in every project.">
          <Select id="ppl-inv-frole" value={fRole} onChange={setFRole} options={[{ value: "", label: "None" }, ...factoryRoles.map((r) => ({ value: r.id, label: r.name }))]} />
        </Field>
        <Field label="First project" htmlFor="ppl-inv-proj">
          <Select id="ppl-inv-proj" value={proj} onChange={setProj} options={[{ value: "", label: "No project yet" }, ...projects.filter((p) => p.status !== "archived").map((p) => ({ value: p.id, label: p.name }))]} />
        </Field>
        <Field label="Role in that project" htmlFor="ppl-inv-prole">
          <Select id="ppl-inv-prole" value={pRole} onChange={setPRole} options={projectRoles.map((r) => ({ value: r.id, label: r.name + (r.custom ? " (custom)" : "") }))} />
        </Field>
      </div>
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}

export function useInviteDialog(args: { perm: Decision; teams: Team[]; projects: Project[]; roles: Role[]; domains: string[]; onDone: (id: string) => void }) {
  const ui = useUI();
  return (preset: { team?: string; project?: string } = {}) => {
    let submit: () => void = () => undefined;
    ui.dialog({
      title: "Invite a person", kicker: "People", wide: true,
      sub: "They get an email with a sign-in link. Until they accept, the policy engine grants them nothing.",
      body: (close) => <InviteForm {...args} preset={preset} close={close} registerSubmit={(fn) => (submit = fn)} />,
      actions: [{ label: "Cancel" }, { label: "Send invite", kind: "primary", icon: "send", submit: true, id: "ppl-inv-submit", guard: args.perm, onClick: () => submit() }],
    });
  };
}
