/**
 * Register MCP server, the prototype form: Name, URL (https), Auth. Registering connects to the server and discovers its tools for real
 * (the edge lists them); write tools and anything the server hints at start denied and need approval before an agent can use them.
 * Transport, the auth header and sensitivity sit in a disclosure. An invalid field is named inline and takes focus.
 */
import { useRef, useState } from "react";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Field, LockNote, Select, focusFirstInvalid } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { SENS, TRANSPORTS, dec } from "./kit";

const AUTHS = [{ value: "bearer", label: "OAuth" }, { value: "header", label: "API key" }, { value: "none", label: "None" }];

export function AddMcp({ close, onAdded }: { close: () => void; onAdded: (id: string) => void }) {
  const ui = useUI();
  const perm = dec(useCan("mcp.edit"));
  const root = useRef<HTMLDivElement>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authMode, setAuthMode] = useState("bearer");
  const [header, setHeader] = useState("x-api-key");
  const [secret, setSecret] = useState("");
  const [transport, setTransport] = useState("http");
  const [sens, setSens] = useState("internal");
  const [errs, setErrs] = useState<{ name?: string; url?: string; secret?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const e: typeof errs = {};
    if (name.trim().length < 3) e.name = "Name must be at least 3 characters.";
    if (!/^https:\/\/.+/.test(url.trim())) e.url = "Use an https:// URL.";
    if (authMode !== "none" && secret.length < 6) e.secret = `Enter the ${authMode === "bearer" ? "token" : "API key"} (6 characters or more).`;
    if (Object.keys(e).length) {
      setErrs(e);
      setTimeout(() => { if (root.current) focusFirstInvalid(root.current); }, 0);
      return;
    }
    setBusy(true);
    const conn = { name: name.trim(), transport, url: url.trim(), authMode, ...(authMode === "header" ? { authHeader: header.trim() || "x-api-key" } : {}), ...(authMode !== "none" && secret ? { secret } : {}) };
    const found = await ops.discoverTools(conn);
    if (!found.ok) { setBusy(false); setErrs({ form: found.msg }); return; }
    const tools = ((found as unknown as { tools?: Array<{ name: string; write: boolean; allowed: boolean }> }).tools ?? []).map((t) => ({ name: t.name, write: t.write, allowed: t.allowed }));
    const r = await ops.addMCP({ ...conn, sensitivity: sens, tools });
    setBusy(false);
    if (!r.ok) { setErrs({ form: r.msg }); return; }
    ui.toast("Registered. Tools are discovered and need approval before agents can use them.", "ok");
    close();
    const id = (r as unknown as { server?: { id: string } }).server?.id;
    if (id) onAdded(id);
  };

  return (
    <Dialog
      title="Register MCP server" onClose={close} dirty={!!(name || url || secret)}
      actions={[{ label: "Cancel" }, { label: busy ? "Registering…" : "Register", kind: "primary", submit: true, id: "mcp-add-go", guard: busy ? { allowed: false, reason: "Connecting and discovering tools." } : perm, onClick: () => { void submit(); } }]}
      body={(
        <div className="form-grid" ref={root}>
          <LockNote decision={perm} what="MCP registry" />
          <Field label="Name" htmlFor="mcp-add-name" error={errs.name}><input id="mcp-add-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="URL" htmlFor="mcp-add-url" error={errs.url} hint="Gantry connects from the factory egress range. Credentials stay in the edge and never reach the runner.">
            <input id="mcp-add-url" className="input mono" value={url} placeholder="https://mcp.example.dev" onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label="Auth" htmlFor="mcp-add-auth"><Select id="mcp-add-auth" options={AUTHS} value={authMode} onChange={setAuthMode} /></Field>
          {authMode !== "none" ? (
            <Field label={authMode === "bearer" ? "Token" : "API key"} htmlFor="mcp-add-secret" error={errs.secret} hint="Stored sealed; never shown again.">
              <input id="mcp-add-secret" className="input mono" type="password" value={secret} autoComplete="off" onChange={(e) => setSecret(e.target.value)} />
            </Field>
          ) : null}
          <details className="int-more">
            <summary>Transport, header and sensitivity</summary>
            <Field label="Transport" htmlFor="mcp-add-transport"><Select id="mcp-add-transport" options={TRANSPORTS} value={transport} onChange={setTransport} /></Field>
            {authMode === "header" ? <Field label="Header" htmlFor="mcp-add-header"><input id="mcp-add-header" className="input mono" value={header} onChange={(e) => setHeader(e.target.value)} /></Field> : null}
            <Field label="Sensitivity" htmlFor="mcp-add-sens"><Select id="mcp-add-sens" options={SENS} value={sens} onChange={setSens} /></Field>
          </details>
          <div className="form-err" role="alert" id="mcp-add-err">{errs.form ?? ""}</div>
        </div>
      )}
    />
  );
}
