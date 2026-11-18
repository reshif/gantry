import { useState } from "react";
import { istTime, type Freeze, type Repo } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Chip, Empty, Field, LockNote, type Decision } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { fmtDay, ifMatchOf, useOutcome } from "../govern/data";

export function FreezeForm({ perm, registerSubmit, close }: { perm: Decision; registerSubmit: (fn: () => void) => void; close: () => void }) {
  const outcome = useOutcome();
  const [name, setName] = useState("");
  // The prototype's defaults: a year-end freeze, 20 Dec to 3 Jan (the coming one).
  const y = new Date().getFullYear() + (new Date() > new Date(`${new Date().getFullYear()}-12-20T00:00:00`) ? 1 : 0);
  const [fromD, setFromD] = useState(`${y}-12-20`);
  const [toD, setToD] = useState(`${y + 1}-01-03`);
  const [err, setErr] = useState("");
  registerSubmit(() => {
    void (async () => {
      if (name.trim().length < 3) return setErr("Name needs at least 3 characters.");
      const a = istTime(fromD, "00:00");
      const b = istTime(toD, "23:59");
      if (!(b > a)) return setErr("End must be after start.");
      const r = outcome(await ops.saveFreeze({ name: name.trim(), repos: "all", from: a, to: b }));
      if (!r.ok) return setErr(r.msg);
      close();
    })();
  });
  return (
    <div className="form-grid">
      <LockNote decision={perm} what="Freezes" />
      <Field label="Name (required)" htmlFor="acc-fz-name"><input id="acc-fz-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="From (required)" htmlFor="acc-fz-from"><input id="acc-fz-from" className="input mono" type="date" value={fromD} onChange={(e) => setFromD(e.target.value)} /></Field>
      <Field label="To (required)" htmlFor="acc-fz-to"><input id="acc-fz-to" className="input mono" type="date" value={toD} onChange={(e) => setToD(e.target.value)} /></Field>
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}

export function useFreezeDialog(perm: Decision) {
  const ui = useUI();
  return () => {
    let submit: () => void = () => undefined;
    ui.dialog({
      title: "New change freeze",
      body: (close) => <FreezeForm perm={perm} close={close} registerSubmit={(fn) => (submit = fn)} />,
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
              <div className="small muted">{`${f.repos === "all" ? "All repos" : f.repos.map((r) => (repos.find((x) => x.id === r)?.name ?? r).replace(/^[^/]+\//, "")).join(", ")} \u00b7 ${fmtDay(f.from)} \u2192 ${fmtDay(f.to)} \u00b7 ${actors(f.by).name}`}</div>
            </div>
            <Chip text={active ? "active" : past ? "ended" : "upcoming"} cls={active ? "warn" : "plain"} />
            {!past ? <Btn icon="trash" aria="Remove freeze" small kind="ghost" cls="icon" id={`acc-fz-end-${f.id}`} guard={perm} onClick={async () => void outcome(await ops.endFreeze(f.id, ifMatchOf(f)), "Freeze removed")} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
