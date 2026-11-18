/** Freezes tab of Project config (prototype "Freezes and release windows"): the freezes that cover this project's repos, with Add freeze and Lift. */
import { fmt, type Repo } from "@gantry/domain";
import { useCan } from "../../api/can";
import { useFreezes, useRepos } from "../../api/queries";
import { Btn } from "../../ui/primitives";
import { Async } from "../../ui/async";
import { Card, CrEmpty, CrIcon } from "../../ui/cr";
import { LiftFreeze, useFreezeDialog } from "../access/Freezes";
import type { PcProps } from "./ctx";

export function FreezesTab({ p }: PcProps) {
  const q = useFreezes();
  const repos = (useRepos(p.id).data ?? []) as Repo[];
  const perm = useCan("policy.edit");
  const add = useFreezeDialog({ allowed: perm.allowed, reason: perm.reason, needs: perm.needs }, repos, () => p.name);
  const now = Date.now();
  return (
    <Async query={q} what="freezes" id="pcf-freezes">
      {(all) => {
        const ids = new Set(repos.map((r) => r.id));
        const rows = (all ?? []).filter((f) => f.repos === "all" || f.repos.some((r) => ids.has(r))).sort((a, b) => a.from - b.from);
        return (
          <Card title="Freezes and release windows" flush acts={<Btn label="Add freeze" kind="primary" small id="pcf-add-freeze" guard={perm} onClick={add}><CrIcon name="plus" /></Btn>}>
            {rows.length ? (
              <div className="list">
                {rows.map((f) => (
                  <div className="li" key={f.id}>
                    <div className="main1">
                      <span className="t1">{f.name}</span>
                      <span className="t2 mono">{`${fmt.stamp(f.from)} → ${fmt.stamp(f.to)} · ${f.repos === "all" ? "all" : f.repos.map((r) => repos.find((x) => x.id === r)?.name ?? r).join(", ")}`}</span>
                    </div>
                    <span className={`chip ${f.from < now ? "warn" : "idle"}`}>{f.from < now ? "Active" : "Scheduled"}</span>
                    {f.to > now ? <LiftFreeze f={f} /> : null}
                  </div>
                ))}
              </div>
            ) : <CrEmpty title="No freezes" text="Schedule one to block releases on chosen repos for a period." icon="clock" />}
          </Card>
        );
      }}
    </Async>
  );
}
