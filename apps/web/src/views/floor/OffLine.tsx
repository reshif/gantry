/**
 * "Off the line" card of the Floor: the project's side bays (Needs a person, Security hold, Queue, Declined and the rest)
 * with the work in each, why it is there, and what a person can do about it (Retry, Return, Assign). The actions are the
 * traveler's own (same guards, same commands), so a locked one says why.
 */
import { flowOf, fmt } from "@gantry/domain";
import { Btn } from "../../ui/primitives";
import { Card, CrEmpty, ListItem } from "../../ui/cr";
import { useOpenTraveler } from "../../shell/useTraveler";
import { useActionSpecs } from "../traveler/Actions";
import { useTravelerWo } from "../traveler/model";
import { since, useFloorCtx, type FWo } from "./kit";

const SHOWN = ["retry", "unpark", "reassign"];

type TWoRead = NonNullable<ReturnType<typeof useTravelerWo>["data"]>;

function Specs({ wo }: { wo: TWoRead }) {
  const specs = (useActionSpecs(wo) ?? []).filter((a) => SHOWN.includes(a.key));
  return (
    <>
      {specs.map((a) => (
        <Btn key={a.key} small label={a.key === "reassign" ? "Assign" : a.label} id={`floor-bay-${a.key}-${wo.id}`} {...(a.key === "retry" || a.key === "unpark" ? { kind: "primary" } : {})} guard={a.guard} onClick={a.onClick} />
      ))}
    </>
  );
}

function BayRowActions({ w }: { w: FWo }) {
  const open = useOpenTraveler();
  const q = useTravelerWo(w.id);
  return (
    <>
      {q.data ? <Specs wo={q.data} /> : null}
      <Btn small label="Open" id={`floor-bay-open-${w.id}`} onClick={() => open(w.id)} />
    </>
  );
}

export function OffLine() {
  const ctx = useFloorCtx();
  const bays = flowOf(ctx.cat, ctx.project).bays;
  const rows = bays.flatMap((b) => ctx.wos.filter((w) => w.bay === b.id && w.state !== "killed" && w.state !== "done").map((w) => ({ b, w })));
  const counts = bays.map((b) => `${b.name} ${rows.filter((r) => r.b.id === b.id).length}`).join(" · ");
  return (
    <Card title="Off the line" hint={counts} id="floor-offline" cls="fl-offline">
      <div className="list">
        {rows.length ? (
          rows.map(({ b, w }) => (
            <ListItem
              key={w.id}
              tone={b.id === "person" || b.id === "sechold" ? "bad" : "warn"}
              title={`${b.name} · ${w.title}`}
              sub={`${w.id} · ${w.bayReason || w.blockReason || w.failReason || b.desc || "No reason given"} · here ${fmt.dur(Math.max(0, ctx.now - since(w)))}`}
            >
              {ctx.replay ? null : <BayRowActions w={w} />}
            </ListItem>
          ))
        ) : (
          <CrEmpty title="Nothing off the line" text={`${bays.map((b) => b.name).join(", ")}: no work waits in a bay right now.`} icon="check" />
        )}
      </div>
    </Card>
  );
}
