/**
 * Register MCP server, the prototype form: Name, URL (https), Auth. Registering connects to the server and discovers its tools for real
 * (the edge lists them); write tools and anything the server hints at start denied and need approval before an agent can use them.
 * Nothing else is asked: transport is HTTP and sensitivity starts at internal. An invalid field is named inline and takes focus.
 */
import { useRef, useState } from "react";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Field, LockNote, Select, focusFirstInvalid } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { dec } from "./kit";

const AUTHS = [{ value: "bearer", label: "OAuth" }, { value: "header", label: "API key" }, { value: "none", label: "None" }];

export function AddMcp({ close }: { close: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("mcp.edit"));
  const root = useRef<HTMLDivElement>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authMode, setAuthMode] = useState("bearer");
  const [errs, setErrs] = useState<{ name?: string; url?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const e: typeof errs = {};
    if (name.trim().length < 3) e.name = "Name must be at least 3 characters.";
    if (!/^https:\/\/.+/.test(url.trim())) e.url = "Use an https:// URL.";
    if (Object.keys(e).length) {
      setErrs(e);
      setTimeout(() => { if (root.current) focusFirstInvalid(root.current); }, 0);
      return;
    }
    setBusy(true);
    const conn = { name: name.trim(), transport: "http", url: url.trim(), authMode, ...(authMode === "header" ? { authHeader: "x-api-key" } : {}) };
    const found = await ops.discoverTools(conn);
    if (!found.ok) { setBusy(false); setErrs({ form: found.msg }); return; }
    const tools = ((found as unknown as { tools?: Array<{ name: string; write: boolean; allowed: boolean }> }).tools ?? []).map((t) => ({ name: t.name, write: t.write, allowed: t.allowed }));
    const r = await ops.addMCP({ ...conn, sensitivity: "internal", tools });
    setBusy(false);
    if (!r.ok) { setErrs({ form: r.msg }); return; }
    ui.toast("Registered. Tools are discovered and need approval before agents can use them.", "ok");
    close();
  };

  return (
    <Dialog
      title="Register MCP server" onClose={close} dirty={!!(name || url)}
      actions={[{ label: "Cancel" }, { label: busy ? "Registering…" : "Register", kind: "primary", submit: true, id: "mcp-add-go", guard: busy ? { allowed: false, reason: "Connecting and discovering tools." } : perm, onClick: () => { void submit(); } }]}
      body={(
        <div className="form-grid" ref={root}>
          <LockNote decision={perm} what="MCP registry" />
          <Field label="Name" htmlFor="mcp-add-name" error={errs.name}><input id="mcp-add-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="URL" htmlFor="mcp-add-url" error={errs.url}>
            <input id="mcp-add-url" className="input mono" value={url} placeholder="https://mcp.example.dev" onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label="Auth" htmlFor="mcp-add-auth"><Select id="mcp-add-auth" options={AUTHS} value={authMode} onChange={setAuthMode} /></Field>
          <div className="form-err" role="alert" id="mcp-add-err">{errs.form ?? ""}</div>
        </div>
      )}
    />
  );
}
