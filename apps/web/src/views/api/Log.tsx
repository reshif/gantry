/** The Request log tab (legacy logTab): every request made with a key, filterable by key and status. */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { useApiRequests } from "../../api/queries";
import { Empty, Field, Panel, Select } from "../../ui/primitives";
import { StatusChip, type ApiData } from "./kit";

export function LogTab({ d }: { d: ApiData }) {
  const [key, setKey] = useState("all");
  const [status, setStatus] = useState("all");
  const q = useApiRequests({ limit: 80, ...(key !== "all" ? { key } : {}), ...(status !== "all" ? { status } : {}) } as { limit: number });
  const raw = q.data;
  const list = Array.isArray(raw) ? raw : raw?.items ?? [];
  return (
    <div className="form-grid">
      <div className="filters">
        <Field label="Key" htmlFor="api-log-key"><Select id="api-log-key" options={[{ value: "all", label: "All keys" }, ...d.allKeys.map((k) => ({ value: k.id, label: k.name }))]} value={key} onChange={setKey} /></Field>
        <Field label="Status" htmlFor="api-log-status">
          <Select id="api-log-status" options={[{ value: "all", label: "All" }, { value: "2xx", label: "Success (2xx)" }, { value: "429", label: "Rate limited (429)" }, { value: "4xx", label: "Refused (4xx)" }]} value={status} onChange={setStatus} />
        </Field>
      </div>
      <Panel flush={!!list.length}>
        {list.length ? (
          <div className="table-scroll" data-keep-scroll="api-log">
            <table className="table table-compact api-log">
              <thead><tr><th>Time (IST)</th><th>Key</th><th>Method</th><th>Path</th><th>Status</th><th className="num">ms</th></tr></thead>
              <tbody>
                {list.map((x, i) => (
                  <tr key={`${x.at}-${i}`}>
                    <td className="mono">{`${fmt.istDate(x.at)} ${fmt.ist(x.at)}`}</td>
                    <td>{d.allKeys.find((k) => k.id === x.key)?.name ?? x.key}</td>
                    <td><span className={`api-m api-m-${x.method.toLowerCase()}`}>{x.method}</span></td>
                    <td className="mono">{x.path}</td>
                    <td><StatusChip code={x.status} /></td>
                    <td className="num mono">{String(x.ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty title="No requests" text="Nothing matches these filters." />}
      </Panel>
    </div>
  );
}
