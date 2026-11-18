/** Add an MCP server (legacy addDialog). Discovery is real: the edge connects to the server and lists its tools. The server rediscovers on add, so the browser's list only carries the admin's choices. */
import { useState } from "react";
import { useCommand } from "../../ui/async";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Field, LockNote, Select } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { AUTH_MODES, Rw, SENS, TRANSPORTS, dec } from "./kit";

interface Found { name: string; write: boolean; allowed: boolean; hint: "read" | "write" | null | undefined }

export function AddMcp({ close, onAdded }: { close: () => void; onAdded: (id: string) => void }) {
  const ui = useUI();
  const perm = dec(useCan("mcp.edit"));
  const [name, setName] = useState("");
  const [transport, setTransport] = useState("http");
  const [url, setUrl] = useState("");
  const [authMode, setAuthMode] = useState("bearer");
  const [header, setHeader] = useState("x-api-key");
  const [secret, setSecret] = useState("");
  const [sens, setSens] = useState("internal");
  const [tools, setTools] = useState<Found[] | null>(null);
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  /** Anything that changes what would answer invalidates the discovered list. */
  const touch = <T,>(set: (v: T) => void) => (v: T) => { set(v); setTools(null); setStatus(""); };

  const conn = () => ({ name: name.trim(), transport, url: url.trim(), authMode, ...(authMode === "header" ? { authHeader: header.trim() || "x-api-key" } : {}), ...(authMode !== "none" && secret ? { secret } : {}) });

  // the outcome shows inline in the status line, so no toast either way
  const discoverCmd = useCommand(ops.discoverTools, { ok: false, toastFail: false });
  const busy = discoverCmd.busy;
  const discover = async () => {
    setErr("");
    if (!name.trim() || !url.trim()) { ui.toast("Enter a name and URL first.", "error"); return; }
    setTools(null);
    const r = await discoverCmd.run(conn());
    if (!r) return;
    if (!r.ok) { setStatus(r.msg); return; }
    const found = ((r as unknown as { tools?: Array<{ name: string; write: boolean; allowed: boolean; hint?: "read" | "write" }> }).tools ?? []);
    setTools(found.length ? found.map((t) => ({ name: t.name, write: t.write, allowed: t.allowed, hint: t.hint })) : null);
    setStatus(r.msg);
  };

  const submit = async () => {
    if (!name.trim() || !url.trim()) return setErr("Name and URL are required.");
    if (!/^https?:\/\/\S+\.?\S*/.test(url.trim())) return setErr("Use an https:// URL.");
    if (authMode !== "none" && secret.length < 6) return setErr(`Enter the secret for ${authMode === "bearer" ? "the bearer token" : "the API key"} (6 characters or more).`);
    if (!tools) return setErr("Discover tools before adding the server.");
    const r = await ops.addMCP({ ...conn(), sensitivity: sens, tools: tools.map((t) => ({ name: t.name, write: t.write, allowed: t.allowed })) });
    if (!r.ok) return setErr(r.msg);
    ui.toast("Server registered", "ok");
    close();
    const id = (r as unknown as { server?: { id: string } }).server?.id;
    if (id) onAdded(id);
  };
  const set = (i: number, patch: Partial<Found>) => setTools((l) => (l ? l.map((t, j) => (j === i ? { ...t, ...patch } : t)) : l));

  return (
    <Dialog title="Register an MCP server" kicker="MCP registry" wide onClose={close} actions={[
      { label: "Cancel", onClick: () => close() },
      { label: "Save", kind: "primary", submit: true, id: "mcp-add-go", guard: perm, onClick: () => void submit() },
    ]} body={(
      <div className="form-grid">
        <LockNote decision={perm} what="MCP registry" />
        <div className="form-row">
          <Field label="Name" htmlFor="mcp-add-name"><input id="mcp-add-name" className="input" value={name} placeholder="Incident tracker" onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Transport" htmlFor="mcp-add-transport"><Select id="mcp-add-transport" options={TRANSPORTS} value={transport} onChange={touch(setTransport)} /></Field>
        </div>
        <Field label="URL" htmlFor="mcp-add-url" hint="Gantry connects from the factory egress range. Credentials stay in the edge and never reach the runner.">
          <input id="mcp-add-url" className="input mono" value={url} placeholder="https://mcp.example.acme.dev/mcp" onChange={(e) => touch(setUrl)(e.target.value)} />
        </Field>
        <div className="form-row">
          <Field label="Auth" htmlFor="mcp-add-auth"><Select id="mcp-add-auth" options={AUTH_MODES} value={authMode} onChange={touch(setAuthMode)} /></Field>
          {authMode === "header" ? <Field label="Header" htmlFor="mcp-add-header"><input id="mcp-add-header" className="input mono" value={header} onChange={(e) => touch(setHeader)(e.target.value)} /></Field> : null}
          <Field label="Secret" htmlFor="mcp-add-secret" hint="Stored sealed; never shown again.">
            <input id="mcp-add-secret" className="input mono" type="password" value={secret} autoComplete="off" disabled={authMode === "none"} onChange={(e) => touch(setSecret)(e.target.value)} />
          </Field>
          <Field label="Data sensitivity" htmlFor="mcp-add-sens"><Select id="mcp-add-sens" options={SENS} value={sens} onChange={setSens} /></Field>
        </div>
        <div className="mcp-disc">
          <Btn label={tools ? "Discover again" : "Discover tools"} icon="search" id="mcp-add-discover" guard={busy ? { allowed: false, reason: "Still connecting." } : perm} onClick={() => void discover()} />
          <span className="muted small" role="status">{busy ? "Connecting and listing tools…" : status || "Gantry lists the server's tools before you add it."}</span>
        </div>
        {tools ? (
          <ul className="mcp-disc-list">
            {tools.map((t, i) => (
              <li key={t.name}>
                <label className="check" htmlFor={`mcp-add-tool-${i}`}>
                  <input type="checkbox" id={`mcp-add-tool-${i}`} checked={t.allowed} onChange={(e) => set(i, { allowed: e.target.checked })} />
                  <span className="mono">{t.name}</span>
                </label>
                <Rw write={t.write} />
                <select id={`mcp-add-class-${i}`} className="input mcp-class" aria-label={`Class of ${t.name}`} value={t.write ? "write" : "read"} onChange={(e) => set(i, { write: e.target.value === "write" })}>
                  <option value="read">read</option>
                  <option value="write">write</option>
                </select>
                {t.hint && (t.hint === "write") !== t.write ? <span className="muted small">server suggests {t.hint}</span> : null}
                {t.write ? <span className="muted small">needs a station pre-authorisation</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="form-err" role="alert" id="mcp-add-err">{err}</div>
        <p className="muted small"><Icon name="lock" /> The server's own read or write hint is only a suggestion. You set each tool's class. Write tools start denied.</p>
      </div>
    )} />
  );
}
