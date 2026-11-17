/** Trust tab (legacy trustTab): levels earned per class and project for an agent a human gate judges, with pending proposals and recent demotions. Reads GET /trust/cells. */
import { DAY, flowOf, fmt, trust, trustAgentFor, type Project, type TrustCell } from "@gantry/domain";
import { useTrustCells } from "../../api/queries";
import { Empty } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { navigate } from "../../lib/router";
import { useCatalog } from "../projects/kit";
import type { AgentRow } from "./kit";

export function TrustTab({ a, projects }: { a: AgentRow; projects: Project[] }) {
  const tq = useTrustCells();
  const cat = useCatalog();
  const tr = tq.data;
  const gate = cat ? cat.gates.find((g) => g.id !== "G0G1" && trustAgentFor({ catalog: cat }, g.id) === a.id) : undefined;
  const vis = projects.filter((p) => p.status !== "archived");
  if (!gate) {
    return (
      <div className="cfg"><section className="cfg-sec ag-wide"><h3 className="cfg-h">Trust by class</h3>
        <Empty id="ag-trust-none" title="Not judged at a gate" text={`${a.name} does not staff the station before a human gate, so it has no trust level. Its work is checked by the agents and people after it.`} />
      </section></div>
    );
  }
  const cells: TrustCell[] = (tr?.cells ?? []).filter((c) => c.agent === a.id && vis.some((p) => p.id === c.project));
  const pend = (tr?.proposals ?? []).filter((x) => x.status === "pending" && cells.some((c) => c.id === x.cell));
  const since = Date.now() - 14 * DAY;
  const dem: Array<{ c: TrustCell; e: TrustCell["history"][number] }> = [];
  for (const c of cells) for (const e of c.history) if (e.kind === "demote" && e.at >= since) dem.push({ c, e });
  const by = [0, 0, 0, 0, 0];
  for (const c of cells) by[c.level] = (by[c.level] ?? 0) + 1;
  const open = () => navigate("trust");
  const label = (c: TrustCell) => `${a.name} · ${c.cls} · ${projects.find((p) => p.id === c.project)?.name ?? c.project}${c.repo ? ` · ${c.repo}` : ""}`;
  const state = { trust: tr ?? { sampleRate: 0, criteria: {}, ceilings: [], cells: [], proposals: [], nextProposal: 1, seededAt: 0 }, projects };
  const rows = vis.filter((p) => cells.some((c) => c.project === p.id && !c.repo)).map((p) => (
    <tr key={p.id}>
      <th scope="row">{p.name}{p.regulated ? <span className="tag">regulated</span> : null}</th>
      <td>
        <span className="ag-trust-cells">
          {flowOf(cat!, p).classes.map((k) => {
            const c = cells.find((x) => x.project === p.id && x.cls === k.id && !x.repo);
            if (!c) return null;
            const ceil = trust.ceiling(state, c.project, c.cls, gate.id);
            const eff = Math.min(c.level, ceil.max);
            const pp = pend.find((x) => x.cell === c.id);
            return (
              <button key={k.id} type="button" className={`ag-trust-cell lvl-${eff}`} id={`ag-trust-${p.id}-${k.id}`} onClick={open}
                title={`${label(c)}: L${c.level} ${trust.level(c.level).name}${eff < c.level ? `, runs at L${eff}` : ""}${pp ? `, promotion to L${pp.to} proposed` : ""}`}>
                <span className="ag-trust-k">{k.name}</span><span className="mono strong">{`L${c.level}`}</span>
                {eff < c.level ? <span className="mono small warn-text">{`→L${eff}`}</span> : null}
                {pp ? <span className="mono small ag-trust-up">{`▲L${pp.to}`}</span> : null}
              </button>
            );
          })}
        </span>
      </td>
    </tr>
  ));
  return (
    <div className="cfg">
      <section className="cfg-sec ag-wide">
        <h3 className="cfg-h">Trust by class</h3>
        <p className="muted small">{`${a.name} is judged at ${gate.label} ${gate.name}. Levels are earned per class and project; select one to see its evidence in Trust.`}</p>
        <dl className="kv-row ag-ident">
          {[0, 1, 2, 3, 4].map((L) => <div key={L} className="kv"><dt className="kv-k">{`L${L} ${trust.level(L).name}`}</dt><dd className="kv-v mono">{String(by[L])}</dd></div>)}
          <div className="kv"><dt className="kv-k">Pending proposals</dt><dd className="kv-v mono">{String(pend.length)}</dd></div>
          <div className="kv"><dt className="kv-k">Demotions 14d</dt><dd className={`kv-v mono${dem.length ? " neg" : ""}`}>{String(dem.length)}</dd></div>
        </dl>
        {rows.length ? (
          <div className="table-scroll"><table className="table table-compact ag-trust"><thead><tr><th scope="col">Project</th><th scope="col">Level by class</th></tr></thead><tbody>{rows}</tbody></table></div>
        ) : <Empty id="ag-trust-empty" title="No trust cells yet" text="Cells appear once this agent has worked on a project you can see." />}
        {dem.length ? (
          <div>
            <h3 className="sub-h">Recent demotions</h3>
            <ul className="plain-list small">
              {dem.map((x, i) => (
                <li key={i}><span className="mono">{`${fmt.istDate(x.e.at)} `}</span><button type="button" className="linkish" id={`ag-trust-dem-${i}`} onClick={open}>{label(x.c)}</button>{` L${x.e.from} ▼ L${x.e.to}: ${x.e.reason}`}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** One line under the agent's header: where its work is judged, the levels it holds and a way into Trust. */
export function TrustStrip({ a, projects }: { a: AgentRow; projects: Project[] }) {
  const tq = useTrustCells();
  const cat = useCatalog();
  if (!cat) return null;
  const gate = cat.gates.find((g) => g.id !== "G0G1" && trustAgentFor({ catalog: cat }, g.id) === a.id);
  if (!gate) {
    return (
      <div className="ag-sum" id="ag-trust-strip"><Icon name="shield" />
        <span>Trust: <b>not judged at a gate</b>. {a.station ? "Its station feeds an automatic gate." : "This agent is off the line."}</span></div>
    );
  }
  const vis = projects.filter((p) => p.status !== "archived");
  const cells = (tq.data?.cells ?? []).filter((c) => c.agent === a.id && vis.some((p) => p.id === c.project));
  const pend = (tq.data?.proposals ?? []).filter((x) => x.status === "pending" && cells.some((c) => c.id === x.cell)).length;
  const since = Date.now() - 14 * DAY;
  const dem = cells.reduce((n, c) => n + c.history.filter((e) => e.kind === "demote" && e.at >= since).length, 0);
  const by = [0, 0, 0, 0, 0];
  for (const c of cells) by[c.level] = (by[c.level] ?? 0) + 1;
  const levels = [1, 2, 3, 4].filter((n) => by[n]).map((n) => `L${n} x${by[n]}`).join(" · ");
  return (
    <div className="ag-sum" id="ag-trust-strip"><Icon name="shield" />
      <span>{`Trust at ${gate.label} ${gate.name}: ${levels || "no cells yet"}${cells.length ? ` across ${cells.length} cell${cells.length === 1 ? "" : "s"}` : ""}`}{pend ? <> · <b>{`${pend} pending`}</b></> : null}{dem ? <span className="neg">{` · ${dem} demotion${dem === 1 ? "" : "s"} in 14 days`}</span> : null}</span>
      <button type="button" className="linkish" id="ag-trust-open" onClick={() => navigate("trust")}>Open in Trust</button>
    </div>
  );
}
