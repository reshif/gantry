import { useState } from "react";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Field, LockNote, Select } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { AUTH_MODES, SENS, TRANSPORTS, dec } from "./kit";

/**
 * Register an MCP server, as the prototype's three-field dialog (Name, URL, Transport) plus Data sensitivity. Registering connects to the server
 * through the edge and lists its tools (real discovery, spec 12.4); write tools start denied. A server that wants credentials is not refused
 * silently: the dialog then asks for the auth mode and the secret, which the edge keeps sealed. stdio servers run on the runner and are not offered.
 */
export function AddMcp({ close, onAdded }: { close: () => void; onAdded: (id: string) => void }) {
  const ui = useUI();
  const perm = dec(useCan("mcp.edit"));
  const [name, setName] = useState("");
  const [transport, setTransport] = useState("http");
  const [url, setUrl] = useState("");
  const [sens, setSens] = useState("internal");
  const [authMode, setAuthMode] = useState("none");
  const [header, setHeader] = useState("x-api-key");
  const [secret, setSecret] = useState("");
  const [needAuth, setNeedAuth] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const conn = () => ({ name: name.trim(), transport, url: url.trim(), authMode, ...(authMode === "header" ? { authHeader: header.trim() || "x-api-key" } : {}), ...(authMode !== "none" && secret ? { secret } : {}) });

  const submit = async () => {
    const e: Record<string, string> = {};
    if (name.trim().length < 3) e.name = name.trim() ? "Name needs at least 3 characters." : "Name is required.";
    if (!url.trim()) e.url = "URL is required.";
    else if (!/^https?:\/\/\S+/.test(url.trim())) e.url = "Use an https:// URL.";
    if (authMode !== "none" && secret.length < 6) e.secret = `Enter the secret for ${authMode === "bearer" ? "the bearer token" : "the API key"} (6 characters or more).`;
    setErrs(e);
    setErr("");
    if (Object.keys(e).length) return;
    setBusy(true);
    const d = await ops.discoverTools(conn());
    const tools = (d as unknown as { tools?: Array<{ name: string; write: boolean; allowed: boolean }> }).tools ?? [];
    if (!d.ok || !tools.length) { setBusy(false); setNeedAuth(true); return setErr(`${d.msg} If the server needs credentials, choose how it authenticates below.`); }
    const r = await ops.addMCP({ ...conn(), sensitivity: sens, tools: tools.map((t) => ({ name: t.name, write: t.write, allowed: t.allowed })) });
    setBusy(false);
    if (!r.ok) return setErr(r.msg);
    ui.toast("Server registered", "ok");
    close();
    const id = (r as unknown as { server?: { id: string } }).server?.id;
    if (id) onAdded(id);
  };

  return (
    <Dialog title="Register an MCP server" kicker="MCP registry" onClose={close} actions={[
      { label: "Cancel", onClick: () => close() },
      { label: busy ? "Connecting…" : "Register", kind: "primary", submit: true, id: "mcp-add-go", guard: busy ? { allowed: false, reason: "Still connecting." } : perm, onClick: () => void submit() },
    ]} body={(
      <div className="form-grid">
        <LockNote decision={perm} what="MCP registry" />
        <Field label="Name (required)" htmlFor="mcp-add-name" error={errs.name}><input id="mcp-add-name" className="input" value={name} placeholder="Incident tracker" onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="URL (required)" htmlFor="mcp-add-url" error={errs.url}>
          <input id="mcp-add-url" className="input mono" value={url} placeholder="https://mcp.example.acme.dev/mcp" onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label="Transport" htmlFor="mcp-add-transport"><Select id="mcp-add-transport" options={TRANSPORTS} value={transport} onChange={setTransport} /></Field>
        <Field label="Data sensitivity" htmlFor="mcp-add-sens"><Select id="mcp-add-sens" options={SENS} value={sens} onChange={setSens} /></Field>
        {needAuth ? (
          <>
            <Field label="Auth" htmlFor="mcp-add-auth"><Select id="mcp-add-auth" options={AUTH_MODES} value={authMode} onChange={setAuthMode} /></Field>
            {authMode === "header" ? <Field label="Header" htmlFor="mcp-add-header"><input id="mcp-add-header" className="input mono" value={header} onChange={(e) => setHeader(e.target.value)} /></Field> : null}
            <Field label="Secret" htmlFor="mcp-add-secret" hint="Stored sealed; never shown again." error={errs.secret}>
              <input id="mcp-add-secret" className="input mono" type="password" value={secret} autoComplete="off" disabled={authMode === "none"} onChange={(e) => setSecret(e.target.value)} />
            </Field>
          </>
        ) : null}
        <div className="form-err" role="alert" id="mcp-add-err">{err}</div>
      </div>
    )} />
  );
}
