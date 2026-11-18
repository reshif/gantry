import { useState } from "react";
import type { Team } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useUI } from "../../ui/overlay-context";
import { Field, LockNote, type Decision } from "../../ui/primitives";
import { useOutcome } from "../govern/data";
import { minLen, required, useFieldErrors } from "../govern/validate";

/** Create or edit a team: POST /teams, PATCH /teams/{id}. */
function TeamForm({ perm, team, close, registerSubmit }: { perm: Decision; team: Team | null; close: () => void; registerSubmit: (fn: () => void) => void }) {
  const outcome = useOutcome();
  const [name, setName] = useState(team?.name ?? "");
  const [desc, setDesc] = useState(team?.desc ?? "");
  const [err, setErr] = useState("");
  const fe = useFieldErrors();

  registerSubmit(() => {
    void (async () => {
      const n = name.trim();
      setErr("");
      if (!fe.run([["ppl-team-name", required("Team name", n) || minLen("Team name", n, 2)]])) return;
      const r = team ? await ops.updateTeam(team.id, { name: n, desc: desc.trim() }) : await ops.createTeam({ name: n, desc: desc.trim() });
      outcome(r);
      if (!r.ok) return setErr(r.msg);
      close();
    })();
  });

  return (
    <div className="form-grid">
      <LockNote decision={perm} what="Teams" />
      <Field label="Team name (required)" htmlFor="ppl-team-name" error={fe.errors["ppl-team-name"]}>
        <input id="ppl-team-name" className="input" autoComplete="off" maxLength={80} value={name} onChange={(e) => { setName(e.target.value); fe.clear("ppl-team-name"); }} />
      </Field>
      <Field label="Description" htmlFor="ppl-team-desc">
        <input id="ppl-team-desc" className="input" autoComplete="off" maxLength={300} value={desc} onChange={(e) => setDesc(e.target.value)} />
      </Field>
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}

export function useTeamDialogs(perm: Decision) {
  const ui = useUI();
  const outcome = useOutcome();
  const edit = (team: Team | null = null) => {
    let submit: () => void = () => undefined;
    ui.dialog({
      title: team ? `Edit ${team.name}` : "New team",
      body: (close) => <TeamForm perm={perm} team={team} close={close} registerSubmit={(fn) => (submit = fn)} />,
      actions: [{ label: "Cancel" }, { label: "Save", kind: "primary", submit: true, id: "ppl-team-submit", guard: perm, onClick: () => submit() }],
    });
  };
  const remove = async (team: Team, members: number) => {
    const ok = await ui.confirm({
      title: `Delete ${team.name}?`, kicker: "People & teams", kind: "danger", ok: "Delete team",
      body: <p>{members ? `${members} member${members === 1 ? "" : "s"} will be removed from this team; their roles and other teams stay. ` : ""}A team that still owns projects or repos cannot be deleted.</p>,
    });
    if (ok) outcome(await ops.deleteTeam(team.id));
  };
  return { create: () => edit(null), edit: (t: Team) => edit(t), remove };
}
