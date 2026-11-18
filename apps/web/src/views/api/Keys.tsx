/** The Keys tab (legacy keysTab, createKeyDialog, secretDialog and the revoke dialog): service accounts scoped to one project and a set of actions, shown once at creation. */
import { useEffect, useState } from "react";
import { DAY, fmt } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { api, get } from "../../api/client";
import { Btn, Empty, Field, LockNote, Panel, Select, type Decision } from "../../ui/primitives";
import { ListView, ago } from "../connect/kit";
import { Dialog } from "../../ui/Overlay";
import { useCopy } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { usePrefs } from "../../lib/prefs";
import { useOutcome } from "../govern/data";
import { dec, useCanAny, type ApiData } from "./kit";
import type { ApiKey } from "@gantry/domain";

/** The prototype's Permissions select: submit and read, or read only (the two further scopes the API knows are the last two choices). */
const PERMS = [
  { value: "submit", label: "Submit and read work orders", actions: ["wo.submit", "wo.read"] },
  { value: "read", label: "Read only", actions: ["wo.read"] },
  { value: "answer", label: "Submit, read and answer intake questions", actions: ["wo.submit", "wo.read", "wo.answer"] },
  { value: "all", label: "Submit, read, answer and fire triggers", actions: ["wo.submit", "wo.read", "wo.answer", "triggers.run"] },
];

export function SecretDialog({ k, secret, project, close }: { k: ApiKey; secret: string; project: string; close: () => void }) {
  const copy = useCopy();
  return (
    <Dialog
      title="Copy your key now" kicker={k.name} onClose={close}
      sub="This is the only time it is shown. It is stored hashed; if you lose it, revoke it and create another."
      body={(
        <div className="form-grid">
          <div className="api-secret">
            <input id="api-secret-value" className="input mono" readOnly value={secret} aria-label="New API key" onFocus={(e) => e.target.select()} />
            <Btn label="Copy key" kind="primary" icon="copy" id="api-secret-copy" onClick={() => copy(secret)} />
          </div>
          <p className="small muted">
            Project <strong>{project}</strong>. Scope: <span className="mono">{k.actions.join(", ")}</span>. Prefix shown later: <span className="mono">{k.prefix}…</span>
            {k.expires ? <> Expires <span className="mono">{fmt.istDate(k.expires)}</span>.</> : null}
          </p>
        </div>
      )}
      actions={[{ label: "Close", kind: "primary", id: "api-secret-done", onClick: () => close() }]}
    />
  );
}

export function CreateKey({ d, close, onCreated }: { d: ApiData; close: () => void; onCreated: (k: ApiKey) => void }) {
  const out = useOutcome();
  const ui = useUI();
  const prefs = usePrefs();
  const [name, setName] = useState("");
  const [project, setProject] = useState(() => (prefs.project && d.visIds.includes(prefs.project) ? prefs.project : d.vis[0]?.id ?? ""));
  const [perm, setPerm] = useState("submit");
  const actions = PERMS.find((x) => x.value === perm)?.actions ?? ["wo.submit", "wo.read"];
  const [err, setErr] = useState("");
  const guard = dec(useCan("api.keys", { project }));
  const submit = async () => {
    if (name.trim().length < 3) { setErr(name.trim() ? "Name needs at least 3 characters." : "Name is required."); return; }
    const r = await ops.createKey({ name: name.trim(), project, actions, expiresInDays: 90 });
    if (!r.ok) { setErr(r.msg); out(r); return; }
    close();
    const key = (r as unknown as { key: ApiKey; secret: string }).key;
    const secret = (r as unknown as { secret: string }).secret;
    ui.open((c) => <SecretDialog k={key} secret={secret} project={d.pname(key.project)} close={c} />);
    onCreated(key);
  };
  return (
    <Dialog
      title="Create API key" kicker="API & triggers" onClose={close}
      body={(
        <div className="form-grid">
          <LockNote decision={guard} what={`API keys on ${d.pname(project)}`} />
          <Field label="Name" htmlFor="api-key-name" hint={`What will use it, e.g. "Jira bridge".`}>
            <input id="api-key-name" className="input" placeholder="Jira bridge" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Project" htmlFor="api-key-project" hint="A key works on one project only.">
            <Select id="api-key-project" options={d.vis.map((p) => ({ value: p.id, label: p.name }))} value={project} onChange={setProject} />
          </Field>
          <Field label="Permissions" htmlFor="api-key-perm" hint="The key is valid for 90 days, then it stops on its own.">
            <Select id="api-key-perm" options={PERMS} value={perm} onChange={setPerm} />
          </Field>
          <div className="form-err" role="alert">{err}</div>
        </div>
      )}
      actions={[{ label: "Cancel" }, { label: "Create key", kind: "primary", submit: true, id: "api-key-go", guard, onClick: () => void submit() }]}
    />
  );
}

function RevokeKey({ k, perm, close }: { k: ApiKey; perm: Decision; close: () => void }) {
  const out = useOutcome();
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void get<{ items: Array<{ at: number }> } | Array<{ at: number }>>(api("api-requests"), { key: k.id, limit: 200 }).then(
      (r) => { if (live) setN((Array.isArray(r) ? r : r.items).filter((x) => x.at > Date.now() - DAY).length); },
      () => { if (live) setN(null); },
    );
    return () => { live = false; };
  }, [k.id]);
  return (
    <Dialog
      title={`Revoke ${k.name}?`} kicker={`API key ${k.prefix}…`} onClose={close}
      body={<p>Requests with this key fail with 401 immediately. {n === null ? "" : `It made ${n} request${n === 1 ? "" : "s"} in the last 24 hours. `}This cannot be undone.</p>}
      actions={[{ label: "Cancel" }, { label: "Revoke key", kind: "danger", id: "api-key-revoke-go", guard: perm, onClick: async () => { const r = out(await ops.revokeKey(k.id)); if (r.ok) close(); } }]}
    />
  );
}

export function KeysTab({ d, onCreated }: { d: ApiData; onCreated: (k: ApiKey) => void }) {
  const ui = useUI();
  const who = useActors();
  const guard = useCanAny("api.keys", d.vis);
  return (
    <Panel title="API keys" flush id="api-keys-panel" tools={<Btn label="New key" small kind="primary" icon="plus" id="api-key-new" guard={guard} onClick={() => ui.open((c) => <CreateKey d={d} close={c} onCreated={onCreated} />)} />}>
      <ListView<ApiKey>
        id="keys" noun="key" rows={d.keys} rowKey={(k) => k.id} rowId={(k) => `api-key-row-${k.id}`}
        text={(k) => `${k.name} ${d.pname(k.project)}`}
        empty={<Empty title="No keys on your projects" text="Create a key to let a system submit work." />}
        columns={[
          { key: "n", label: "Name", sort: (k) => k.name.toLowerCase(), render: (k) => <div><b>{k.name}</b><span className="sub mono" title={`by ${who(k.by).name}`}>gk_••••{k.id}</span></div> },
          { key: "p", label: "Project", render: (k) => d.pname(k.project) },
          { key: "a", label: "Allowed", render: (k) => <div className="row">{k.actions.map((a) => <span key={a} className="chip plain">{a}</span>)}</div> },
          { key: "u", label: "Last used", render: (k) => (k.lastUsed ? ago(k.lastUsed) : "never") },
          { key: "s", label: "State", render: (k) => (
            <div>
              <span className={`chip ${k.revoked || k.expired ? "bad" : "ok"}`}>{k.revoked ? "revoked" : k.expired ? "expired" : "active"}</span>
              {!k.revoked && k.expires ? <span className="sub">{k.expired ? "expired " : "expires "}{fmt.istDate(k.expires)}</span> : null}
            </div>
          ) },
          { key: "x", label: "", align: "end", render: (k) => (k.revoked ? <span className="muted">{"\u2014"}</span> : <RevokeBtn k={k} />) },
        ]}
      />
    </Panel>
  );
}

function RevokeBtn({ k }: { k: ApiKey }) {
  const ui = useUI();
  const perm = dec(useCan("api.keys", { project: k.project }));
  return <Btn label="Revoke" small kind="danger" id={`api-key-revoke-${k.id}`} guard={perm} onClick={() => ui.open((c) => <RevokeKey k={k} perm={perm} close={c} />)} />;
}
