/** The instructions a work order runs on (S-143, S-145): its context pin, the commit each run was seeded at and why, what was read as conventions, and a Refresh button. */
import { useCan } from "../../api/can";
import { commands } from "../../api/commands";
import { useCommand } from "../../lib/useCommand";
import { Btn } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { Fold, Kv, Prov, useName, when } from "./bits";
import type { Ctx } from "./sections";

const short = (s: string | null | undefined): string => (s ? s.slice(0, 12) : "none");
const SOURCE: Record<string, string> = { default_head: "default branch head, read at dispatch", base_sha: "recorded base commit", pr_head: "pull request head", wo_commit: "latest commit of this work order", eval_pin: "the snapshot this case was written against" };

export function RecordContext({ c }: { c: Ctx }) {
  const { wo, rec } = c;
  const ctx = rec.context;
  const name = useName();
  const can = useCan("wo.sendback", { project: wo.project, repo: wo.repo });
  const refresh = useCommand(commands.refreshContext, { ok: "Instructions refreshed. The next run uses what is published now." });
  if (!ctx || (!ctx.pin && !ctx.notices.length && !ctx.runs.length)) return null;
  const pin = ctx.pin;
  const withSeed = ctx.runs.filter((r) => r.seed);
  return (
    <div className="rec-context" id={`${c.pre}context`}>
      <div className="rec-subhead">
        <span className="small muted">{pin ? `Instructions this work order runs on: ${pin.id}, pinned ${when(Date.parse(pin.pinnedAt))}` : "No instructions pinned yet."}</span>
        <Prov kind="system" text="Pinned by Gantry at the first run" />
        <Btn label="Refresh instructions" small icon="refresh" id={`${c.pre}ctx-refresh`} guard={can} disabledReason={can.allowed ? refresh.wait("Refreshing") : null} onClick={() => void refresh.run(wo.id, undefined, { ifMatch: rec.version })} />
      </div>
      {refresh.error ? <div className="callout callout-fail" role="alert">{refresh.error}</div> : null}
      {ctx.notices.map((n, i) => (
        <div key={`${n.run}-${n.kind}-${i}`} className="callout callout-warn" role="status">
          <Icon name="alert" />
          {` ${n.text}`}
        </div>
      ))}
      {pin ? (
        <dl className="rec-kvs">
          <Kv k="Factory base">{pin.base === null ? "none published" : `v${pin.base}`}</Kv>
          <Kv k="Project overlay">{pin.project === null ? "the project's own text" : `v${pin.project}`}</Kv>
          <Kv k="Repo guidelines">{pin.guidelines ? `${short(pin.guidelines.hash)}${pin.guidelines.commit ? ` at ${short(pin.guidelines.commit)}` : ""}` : "none"}</Kv>
          <Kv k="Agents">{Object.keys(pin.agents).length ? Object.entries(pin.agents).map(([id, a]) => `${name(id)} v${a.version}`).join(", ") : "none yet"}</Kv>
        </dl>
      ) : null}
      <p className="small muted">Stations, retries and send-back redos reuse this. It moves only when a person chooses Refresh instructions, or when a pinned version was retired; both are recorded.</p>
      {ctx.repins.length ? (
        <ul className="rec-list small">
          {ctx.repins.map((r) => (
            <li key={r.seq}>
              <Icon name="refresh" />
              {` ${when(r.at ? Date.parse(r.at) : null)}: ${r.by === "system" ? "re-pinned by Gantry" : `refreshed by ${name(r.by)}`}${r.detail?.reason ? `. ${r.detail.reason}` : ""}`}
            </li>
          ))}
        </ul>
      ) : null}
      {withSeed.length ? (
        <Fold k={`${c.pre}ctx-runs-${wo.id}`} summary={<span className="small">{`What each run was given (${withSeed.length})`}</span>}>
          <ul className="rec-list small">
            {withSeed.map((r) => (
              <li key={r.run}>
                <span className="mono">{`${r.station} · ${short(r.seed?.commit)}`}</span>
                {` ${SOURCE[r.seed?.source ?? ""] ?? r.seed?.source ?? ""}. ${r.seed?.why ?? ""} `}
                {r.conventions.state === "read" ? `Conventions read at ${short(r.conventions.commit)}.` : r.conventions.state === "unavailable" ? "Conventions could not be read." : "No convention files."}
                {r.proposedChanges.length ? ` This work order proposes changes to ${r.proposedChanges.map((f) => f.path).join(", ")} (not the maintainers' text).` : ""}
              </li>
            ))}
          </ul>
        </Fold>
      ) : null}
    </div>
  );
}
