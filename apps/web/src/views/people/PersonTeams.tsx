/** Team membership of one person: a checklist of teams (PUT /people/{id}/teams). Used by the person page ("Change" next to Teams) and by a team's "Add member". */
import { useState } from "react";
import type { Person } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useUI } from "../../ui/overlay-context";
import { Btn, LockNote, Toggle, type Decision } from "../../ui/primitives";
import { useOutcome } from "../govern/data";

type TeamRef = { id: string; name: string };

function TeamsForm({ p, teams, perm, close, registerSubmit }: { p: Person; teams: TeamRef[]; perm: Decision; close: () => void; registerSubmit: (fn: () => void) => void }) {
  const outcome = useOutcome();
  const [picked, setPicked] = useState<string[]>(p.teams ?? []);
  const [err, setErr] = useState("");
  registerSubmit(() => {
    void (async () => {
      if (!picked.length) return setErr("Keep at least one team.");
      const r = await ops.setTeams(p.id, picked);
      outcome(r, "Teams saved");
      if (!r.ok) return setErr(r.msg);
      close();
    })();
  });
  return (
    <div className="form-grid">
      <LockNote decision={perm} what="Team membership" />
      <div className="check-grid">
        {teams.map((t) => (
          <label key={t.id} className="check" htmlFor={`ppl-tm-${t.id}`}>
            <Toggle id={`ppl-tm-${t.id}`} variant="check" label={t.name} checked={picked.includes(t.id)} decision={perm} onChange={(on) => { setErr(""); setPicked(on ? [...picked, t.id] : picked.filter((x) => x !== t.id)); }} />
            {t.name}
          </label>
        ))}
      </div>
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}

/** Opens the teams dialog for a person. */
export function useEditTeams(args: { teams: TeamRef[]; guard: Decision }) {
  const ui = useUI();
  return (p: Person) => {
    let submit: () => void = () => undefined;
    ui.dialog({
      title: `Teams of ${p.name}`,
      body: (close) => <TeamsForm p={p} teams={args.teams} perm={args.guard} close={close} registerSubmit={(fn) => (submit = fn)} />,
      actions: [{ label: "Cancel" }, { label: "Save teams", kind: "primary", submit: true, id: "ppl-tm-save", guard: args.guard, onClick: () => submit() }],
    });
  };
}

/** "Add member" on a team: pick a person who is not in it; their teams plus this one are sent through the same command. */
export function useAddMember(args: { people: Person[]; guard: Decision }) {
  const ui = useUI();
  return (team: TeamRef) => {
    const candidates = args.people.filter((p) => p.status !== "deactivated" && !(p.teams ?? []).includes(team.id));
    ui.dialog({
      title: `Add a member to ${team.name}`,
      body: (close) => <AddMemberList team={team} candidates={candidates} close={close} guard={args.guard} />,
      actions: [{ label: "Close", kind: "primary" }],
    });
  };
}

function AddMemberList({ team, candidates, close, guard }: { team: TeamRef; candidates: Person[]; close: () => void; guard: Decision }) {
  const outcome = useOutcome();
  const [err, setErr] = useState("");
  const add = async (p: Person) => {
    const r = await ops.setTeams(p.id, [...(p.teams ?? []), team.id]);
    outcome(r, `${p.name} added to ${team.name}`);
    if (!r.ok) return setErr(r.msg);
    close();
  };
  return (
    <div className="form-grid">
      <LockNote decision={guard} what="Team membership" />
      {candidates.length ? (
        <ul className="list" id={`ppl-am-${team.id}`}>
          {candidates.map((p) => (
            <li key={p.id}>
              <div className="grow">{p.name}<span className="small muted">{` \u00b7 ${p.email}`}</span></div>
              <Btn label="Add" small id={`ppl-am-${team.id}-${p.id}`} guard={guard} onClick={() => void add(p)} />
            </li>
          ))}
        </ul>
      ) : <div className="muted">Everyone is already in {team.name}.</div>}
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}
