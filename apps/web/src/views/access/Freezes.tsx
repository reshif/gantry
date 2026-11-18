import { useState } from "react";
import { fmt, istTime, istToday, type Freeze, type Repo } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Chip, Empty, Field, LockNote, Select, type Decision } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { ifMatchOf, useOutcome } from "../govern/data";

export function FreezeForm({ perm, repos, projectName, registerSubmit, close }: { perm: Decision; repos: Repo[]; projectName: (id: string) => string; registerSubmit: (fn: () => void) => void; close: () => void }) {
  const outcome = useOutcome();
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("all");
  const [fromD, setFromD] = useState(istToday(Date.now(), 1));
  const [toD, setToD] = useState(istToday(Date.now(), 3));
  const [err, setErr] = useState("");
  registerSubmit(() => {
    void (async () => {
      if (!name.trim()) return setErr("Name the freeze.");
      const a = istTime(fromD, "00:00");
      const b = istTime(toD, "23:59");
      if (!(b > a)) return setErr("End must be after start.");
      const r = outcome(await ops.saveFreeze({ name: name.trim(), repos: repo === "all" ? "all" : [repo], from: a, to: b }));
      if (!r.ok) return setErr(r.msg);
      close();
    })();
  });
  return (
    <div className="form-grid">
      <LockNote decision={perm} what="Freezes" />
      <Field label="Name" htmlFor="acc-fz-name"><input id="acc-fz-name" className="input" placeholder="Quarter-end close" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Repos (optional)" htmlFor="acc-fz-repos"><Select id="acc-fz-repos" value={repo} onChange={setRepo} options={[{ value: "all", label: "Every repo in every project" }, ...repos.map((r) => ({ value: r.id, label: `${r.name} · ${projectName(r.project)}` }))]} /></Field>
      <Field label="From" htmlFor="acc-fz-from"><input id="acc-fz-from" className="input mono" type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} /></Field>
      <Field label="To" htmlFor="acc-fz-to" hint="The freeze runs to the end of this day (IST)."><input id="acc-fz-to" className="input mono" type="date" value={toD} onChange={(e) => setToD(e.target.value)} /></Field>
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}

export function useFreezeDialog(perm: Decision, repos: Repo[], projectName: (id: string) => string) {
  const ui = useUI();
  return () => {
    let submit: () => void = () => undefined;
    ui.dialog({
      title: "New change freeze",
      sub: "While a freeze is active, POL-110 denies every release on the frozen repos, whatever other policies say.",
      body: (close) => <FreezeForm perm={perm} repos={repos} projectName={projectName} close={close} registerSubmit={(fn) => (submit = fn)} />,
      actions: [{ label: "Cancel" }, { label: "Save", kind: "primary", submit: true, id: "acc-fz-save", guard: perm, onClick: () => submit() }],
    });
  };
}

export function FreezeList({ freezes, repos }: { freezes: Freeze[]; repos: Repo[] }) {
  const outcome = useOutcome();
  const perm = useCan("policy.edit");
  const actors = useActors();
  const now = Date.now();
  if (!freezes.length) return <Empty title="No freezes" text="Schedule one to block releases on chosen repos for a period." />;
  return (
    <ul className="list acc-freezes">
      {[...freezes].sort((a, b) => a.from - b.from).map((f) => {
        const active = now >= f.from && now < f.to;
        const past = now >= f.to;
        return (
          <li key={f.id} id={`acc-frz-${f.id}`}>
            <div className="grow">
              <b>{f.name}</b>
              <div className="small muted">{`${f.repos === "all" ? "All repos" : f.repos.map((r) => repos.find((x) => x.id === r)?.name ?? r).join(", ")} \u00b7 ${fmt.istDate(f.from)} \u2192 ${fmt.istDate(f.to)} \u00b7 ${actors(f.by).name}`}</div>
            </div>
            <Chip text={active ? "active" : past ? "ended" : "upcoming"} cls={active ? "warn" : "plain"} />
            {!past ? <Btn icon="trash" aria="Remove freeze" small kind="ghost" cls="icon" id={`acc-fz-end-${f.id}`} guard={perm} onClick={async () => void outcome(await ops.endFreeze(f.id, ifMatchOf(f)), "Freeze removed")} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
