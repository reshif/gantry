/** The Request log tab (prototype "Last requests"): every request made with a key, newest first, searchable and filterable by status. */
import type { RequestLogEntry } from "@gantry/domain";
import { Panel } from "../../ui/primitives";
import { ListView, ago } from "../connect/kit";
import type { ApiData } from "./kit";

export function LogTab({ d }: { d: ApiData }) {
  return (
    <Panel title="Last requests" flush id="api-log-panel">
      <ListView<RequestLogEntry>
        id="rq" noun="request" rows={d.log} rowKey={(x) => `${x.at}-${x.method}-${x.path}-${x.key}`}
        text={(x) => `${x.path} ${x.method} ${x.key}`}
        filters={[{ key: "status", label: "Status", options: ["200", "201", "400", "401", "429", "500"] }]}
        columns={[
          { key: "at", label: "When", sort: (x) => x.at, render: (x) => ago(x.at) },
          { key: "method", label: "Method", render: (x) => <span className="mono">{x.method}</span> },
          { key: "path", label: "Path", render: (x) => <span className="mono small">{x.path}</span> },
          { key: "status", label: "Status", render: (x) => <span className={`chip ${x.status < 300 ? "ok" : x.status < 500 ? "warn" : "bad"}`}>{String(x.status)}</span> },
          { key: "key", label: "Key", render: (x) => x.key },
          { key: "ms", label: "ms", align: "end", sort: (x) => x.ms, render: (x) => <span className="num">{x.ms}</span> },
        ]}
      />
    </Panel>
  );
}
