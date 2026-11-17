/** Design-system page pieces that need a little data of their own, kept out of the view file. */
import { Chip, Empty, Field, Meter, Segmented, Select, Status as StatusChip, Tabs, Toggle, Btn } from "../../ui/primitives";
import { DataTable } from "../../ui/DataTable";

export { Btn, Chip, Empty, Field, Meter, Segmented, Select, StatusChip, Tabs, Toggle };

interface Row { id: string; title: string; state: string; age: string }
const ROWS: Row[] = [
  { id: "WO-1004", title: "Rate limit the payout API", state: "Gate G5", age: "3h 20m" },
  { id: "WO-1012", title: "Fix cart total flicker", state: "Running", age: "1h 05m" },
];

export function DataTableDemo() {
  return (
    <DataTable<Row>
      caption="Example work orders"
      rows={ROWS}
      rowKey={(r) => r.id}
      columns={[
        { key: "id", label: "ID", render: (r) => <b className="mono">{r.id}</b> },
        { key: "title", label: "Title" },
        { key: "state", label: "State", render: (r) => <Chip text={r.state} cls={r.state === "Running" ? "info" : "warn"} /> },
        { key: "age", label: "Age", align: "end", render: (r) => <span className="mono">{r.age}</span> },
      ]}
    />
  );
}
