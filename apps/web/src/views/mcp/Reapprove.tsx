/**
 * Re-approve changed definitions of an MCP server: the tools whose definition the server now reports differently, the rule that decides
 * who may approve, how long ago it was found, and the real approval (`approveMCP`). Gantry connects again and accepts exactly what the server reports now.
 */
import type { McpServer } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { LockNote } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { agoShort } from "../connect/kit";
import { dec } from "./kit";

export function ReapproveDialog({ srv, close }: { srv: McpServer; close: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("mcp.edit"));
  const changed = srv.tools.filter((t) => t.changed);
  return (
    <Dialog
      title={`Re-approve changed definitions of ${srv.name}`} sub="The server describes these tools differently from what was approved. A changed description can change what an agent does with a tool." onClose={close}
      actions={[{ label: "Cancel" }, { label: "Approve changed definitions", kind: "primary", id: "mcp-approve-go", guard: perm, onClick: async () => {
        const r = await ops.approveMCP(srv.id, srv.version !== undefined ? { ifMatch: srv.version } : undefined);
        ui.toast(r.ok ? `Approved the changed definitions of ${srv.name}.` : r.msg, r.ok ? "ok" : "error");
        if (r.ok) close();
      } }]}
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what="Approving MCP changes" />
          <div className="card"><div className="card-b flush">
            {changed.length ? changed.map((t) => (
              <div className="setrow" key={t.name}><div className="tx"><b className="mono">{t.name}</b><span>{t.write ? "Write tool: runs behind a gate" : "Read only"}. Definition changed.</span></div></div>
            )) : <div className="setrow"><div className="tx"><b>Address or protocol</b><span>The server address changed.</span></div></div>}
          </div></div>
          <dl className="kv">
            <dt>Approver rule</dt><dd>{perm.needs ? `Needs ${perm.needs}` : "Anyone who may edit the MCP registry"}</dd>
            <dt>Found</dt><dd>{srv.discoveredAt ? agoShort(srv.discoveredAt) : "not recorded"}</dd>
          </dl>
          <p className="muted small">If the server changed once more since you looked, the approval is refused and you review again.</p>
        </div>
      )}
    />
  );
}
