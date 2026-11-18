/**
 * Re-approve changed definitions of an MCP server, in the prototype's approval dialog: sub "MCP server <id>", Evidence, a code diff of the
 * changed tools, Rule / Eligible / Waiting, a Comment, and Cancel, Request changes, Reject, Approve. Only Approve is a real registry
 * action (`approveMCP`, which connects again and accepts exactly what the server reports now); the registry has no reject or
 * request-changes decision, so those two say so instead of pretending.
 */
import { useState } from "react";
import type { McpServer } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Field, LockNote, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { Kv, agoShort } from "../connect/kit";
import { dec } from "./kit";

const NO_DECISION: Decision = { allowed: false, reason: "The MCP registry records approvals only. Approve, or leave the change paused." };

export function ReapproveDialog({ srv, close }: { srv: McpServer; close: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("mcp.edit"));
  const [note, setNote] = useState("");
  const changed = srv.tools.filter((t) => t.changed);
  const unchanged = srv.tools.length - changed.length;
  const evidence = changed.length
    ? `${changed.length === 1 ? `Tool ${changed[0]!.name} changed its definition` : `Tools ${changed.map((t) => t.name).join(", ")} changed their definitions`}. ${unchanged} ${unchanged === 1 ? "tool" : "tools"} unchanged.`
    : "The server address or protocol changed.";
  return (
    <Dialog
      title={`Re-approve changed definitions of ${srv.name}`} sub={`MCP server ${srv.id}`} onClose={close}
      actions={[
        { label: "Cancel" },
        { label: "Request changes", id: "mcp-changes-go", guard: NO_DECISION },
        { label: "Reject", kind: "danger", id: "mcp-reject-go", guard: NO_DECISION },
        { label: "Approve", kind: "ok", id: "mcp-approve-go", guard: perm, onClick: async () => {
          const r = await ops.approveMCP(srv.id, srv.version !== undefined ? { ifMatch: srv.version } : undefined);
          ui.toast(r.ok ? `Approved: ${srv.name}` : r.msg, r.ok ? "ok" : "error");
          if (r.ok) close();
        } },
      ]}
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what="Approving MCP changes" />
          <div><div className="label" style={{ marginBottom: 4 }}>Evidence</div><p>{evidence}</p></div>
          {changed.length ? <pre className="code diff" style={{ padding: 8 }}>{changed.map((t) => <div key={t.name}>~ {t.name}</div>)}</pre> : null}
          <Kv rows={[
            ["Rule", "1 approver (0 of 1 so far)"],
            ["Eligible", perm.needs ?? "not available"],
            ["Waiting", srv.discoveredAt ? agoShort(srv.discoveredAt) : "not recorded"],
          ]} />
          <Field label="Comment" htmlFor="mcp-approve-note" hint="Required when rejecting or requesting changes (10+ characters).">
            <textarea id="mcp-approve-note" className="input" rows={3} placeholder="Why, in a sentence" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      )}
    />
  );
}
