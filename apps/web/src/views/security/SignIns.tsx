/** Security, Sign-in log tab (prototype "Recent sign-ins"): search email and device, Outcome and Method selects, sortable When, 12 per page. */
import type { SignIn } from "@gantry/domain";
import { fmt } from "@gantry/domain";
import { DataTable, type Col } from "../../ui/DataTable";
import { Btn, Chip, Panel } from "../../ui/primitives";
import { ListBar } from "../govern/listkit";
import { useQueryParam } from "../floor/urlState";

export function SignInsTab({ signins }: { signins: SignIn[] }) {
  const [qp, setQ] = useQueryParam("gq");
  const [op, setO] = useQueryParam("go");
  const [mp, setM] = useQueryParam("gm");
  const q = qp ?? "";
  const outcome = op ?? "all";
  const method = mp ?? "all";
  const now = Date.now();
  const needle = q.trim().toLowerCase();
  const rows = signins.filter((s) => (!needle || `${s.email}${s.device}`.toLowerCase().includes(needle)) && (outcome === "all" || s.outcome === outcome) && (method === "all" || s.method === method));
  const methods = ["sso", "demo", "password", ...signins.map((s) => s.method)].filter((m, i, a) => a.indexOf(m) === i);
  const clear = () => { setQ(null); setO(null); setM(null); };
  const cols: Col<SignIn>[] = [
    { key: "at", label: "When", sort: (s) => s.at, render: (s) => fmt.ago(s.at, now) },
    { key: "e", label: "Account", render: (s) => s.email },
    { key: "m", label: "Method", render: (s) => s.method },
    { key: "d", label: "Device", render: (s) => s.device },
    { key: "o", label: "Outcome", render: (s) => <Chip text={s.outcome} cls={s.outcome === "success" ? "ok" : "bad"} /> },
    { key: "r", label: "Reason", render: (s) => s.reason || "—" },
  ];
  return (
    <Panel title="Recent sign-ins" flush id="sec-signins-panel">
      <ListBar
        id="sec-hist" label="Sign-in log" q={q} onQ={(v) => setQ(v || null)} shown={rows.length} total={signins.length} noun="sign-in" onClear={clear}
        filters={[
          { id: "outcome", label: "Outcome", value: outcome, onChange: (v) => setO(v === "all" ? null : v), options: [{ value: "all", label: "All" }, "success", "failure"] },
          { id: "method", label: "Method", value: method, onChange: (v) => setM(v === "all" ? null : v), options: [{ value: "all", label: "All" }, ...methods] },
        ]}
      />
      <DataTable id="sec-hist-table" caption="Recent sign-ins" columns={cols} rows={rows} rowKey={(s) => `${s.at}-${s.email}-${s.ip}-${s.outcome}-${s.reason}`} pageSize={12} pager
        empty={signins.length ? { title: "Nothing matches these filters", text: "Loosen the search or clear the filters.", action: <Btn label="Clear filters" id="sec-hist-empty-clear" onClick={clear} /> } : { title: "Nothing here yet", text: "Items will appear here when they exist." }} />
    </Panel>
  );
}
