import { useState } from "react";
import { fmt, istTime, istToday, type Freeze, type Repo } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Chip, Empty, Field, LockNote, Select, type Decision } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { ifMatchOf, useOutcome } from "../govern/data";

export function FreezeForm({ perm, repos, projectName, registerSubmit, close }: { perm: Decision; repos: Repo[]; projectName: (id: string) => string; registerSubmit: (fn: () => void) => void; close: () => void }) {
  const outcome = useOutcome();
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("all");
  const [fromD, setFromD] = useState(istToday(Date.now(), 1));
  const [fromT, setFromT] = useState("00:00");
  const [toD, setToD] = useState(istToday(Date.now(), 3));
  const [toT, setToT] = useState("09:00");
  const [err, setErr] = useState("");
  registerSubmit(() => {
    void (async () => {
      if (!name.trim()) return setErr("Name the freeze.");
      const a = istTime(fromD, fromT || "00:00");
      const b = istTime(toD, toT || "00:00");
      if (!(b > a)) return setErr("The end must be after the start.");
      const r = outcome(await ops.saveFreeze({ name: name.trim(), repos: repo === "all" ? "all" : [repo], from: a, to: b }));
      if (!r.ok) return setErr(r.msg);
      close();
    })();
  });
  return (
    <div className="form-grid">
      <LockNote decision={perm} what="Freezes" />
      <Field label="Name" htmlFor="acc-fz-name"><input id="acc-fz-name" className="input" placeholder="Quarter-end close" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Repos" htmlFor="acc-fz-repos"><Select id="acc-fz-repos" value={repo} onChange={setRepo} options={[{ value: "all", label: "Every repo in every project" }, ...repos.map((r) => ({ value: r.id, label: `${r.name} · ${projectName(r.project)}` }))]} /></Field>
      <div className="form-row">
        <Field label="From (IST)" htmlFor="acc-fz-from"><input id="acc-fz-from" className="input mono" type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} /></Field>
        <Field label="Time" htmlFor="acc-fz-fromt"><input id="acc-fz-fromt" className="input mono" type="time" value={fromT} onChange={(e) => setFromT(e.target.value)} /></Field>
      </div>
      <div className="form-row">
        <Field label="Until (IST)" htmlFor="acc-fz-to"><input id="acc-fz-to" className="input mono" type="date" value={toD} onChange={(e) => setToD(e.target.value)} /></Field>
        <Field label="Time" htmlFor="acc-fz-tot"><input id="acc-fz-tot" className="input mono" type="time" value={toT} onChange={(e) => setToT(e.target.value)} /></Field>
      </div>
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}

export function useFreezeDialog(perm: Decision, repos: Repo[], projectName: (id: string) => string) {
  const ui = useUI();
  return () => {
    let submit: () => void = () => undefined;
    ui.dialog({
      title: "Schedule a freeze", kicker: "Access · change window",
      sub: "While a freeze is active, POL-110 denies every release on the frozen repos, whatever other policies say.",
      body: (close) => <FreezeForm perm={perm} repos={repos} projectName={projectName} close={close} registerSubmit={(fn) => (submit = fn)} />,
      actions: [{ label: "Cancel" }, { label: "Schedule freeze", kind: "primary", submit: true, id: "acc-fz-save", guard: perm, onClick: () => submit() }],
    });
  };
}

export function FreezeList({ freezes, repos, hlFreeze }: { freezes: Freeze[]; repos: Repo[]; hlFreeze: string | null }) {
  const outcome = useOutcome();
  const perm = useCan("policy.edit");
  const actors = useActors();
  const now = Date.now();
  if (!freezes.length) return <Empty title="No freezes" text="Schedule one to block releases on chosen repos for a period." />;
  return (
    <ul className="freezes acc-freezes">
      {[...freezes].sort((a, b) => a.from - b.from).map((f) => {
        const active = now >= f.from && now < f.to;
        const past = now >= f.to;
        return (
          <li key={f.id} className={`freeze${active ? " is-active" : ""}${past ? " is-past" : ""}${hlFreeze === f.id ? " is-hl" : ""}`} id={`acc-frz-${f.id}`}>
            <div className="fz-top">
              <span className="mono strong">{f.id}</span>
              {active ? <span className="chip chip-block"><Icon name="halt" />active now</span> : past ? <Chip text="ended" /> : <span className="chip"><Icon name="clock" />upcoming</span>}
            </div>
            <div className="strong">{f.name}</div>
            <div className="mono small">{`${fmt.stamp(f.from)} → ${fmt.stamp(f.to)}`}</div>
            <div className="small muted">{`Repos: ${f.repos === "all" ? "every repo" : f.repos.map((r) => repos.find((x) => x.id === r)?.name ?? r).join(", ")} · set by ${actors(f.by).name}`}</div>
            {!past ? <Btn label={active ? "End freeze now" : "Cancel freeze"} small kind="ghost" id={`acc-fz-end-${f.id}`} guard={perm} onClick={async () => void outcome(await ops.endFreeze(f.id, ifMatchOf(f)))} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
