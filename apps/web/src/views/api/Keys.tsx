/** The Keys tab (legacy keysTab, createKeyDialog, secretDialog and the revoke dialog): service accounts scoped to one project and a set of actions, shown once at creation. */
import { useEffect, useRef, useState } from "react";
import { DAY, fmt } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { api, get } from "../../api/client";
import { DataTable } from "../../ui/DataTable";
import { Btn, Field, FilterBar, LockNote, SearchBox, Select, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { Icon } from "../../ui/Icon";
import { tip } from "../../ui/Tip";
import { useCopy } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { usePrefs } from "../../lib/prefs";
import { useOutcome } from "../govern/data";
import { KEY_ACTIONS, dec, useCanAny, type ApiData } from "./kit";
import type { ApiKey } from "@gantry/domain";

const EXPIRY = [{ value: "30", label: "30 days" }, { value: "90", label: "90 days (default)" }, { value: "180", label: "180 days" }, { value: "365", label: "1 year" }];

export function SecretDialog({ k, secret, project, close }: { k: ApiKey; secret: string; project: string; close: () => void }) {
  const ui = useUI();
  const copy = useCopy();
  const [stored, setStored] = useState(false);
  const done = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      title="Copy your new key now" kicker={k.name} onClose={() => { if (!stored) { if (done.current) tip.show(done.current); return; } close(); }}
      sub="This is the only time Gantry shows the full key. It is stored hashed; if you lose it, revoke it and create another."
      body={(
        <div className="form-grid">
          <div className="api-secret">
            <input id="api-secret-value" className="input mono" readOnly value={secret} aria-label="New API key" onFocus={(e) => e.target.select()} />
            <Btn label="Copy key" kind="primary" icon="copy" id="api-secret-copy" onClick={() => copy(secret)} />
          </div>
          <div className="callout callout-warn">
            <Icon name="key" />
            <span>
              Project <strong>{project}</strong>. Scope: <span className="mono">{k.actions.join(", ")}</span>. Prefix shown later: <span className="mono">{k.prefix}…</span>
              {k.expires ? <> Expires <span className="mono">{fmt.istDate(k.expires)}</span>.</> : null}
            </span>
          </div>
          <label className="check" htmlFor="api-secret-ack">
            <input type="checkbox" id="api-secret-ack" checked={stored} onChange={(e) => setStored(e.target.checked)} />
            I have stored this key somewhere safe
          </label>
        </div>
      )}
      actions={[{ label: "Done", kind: "primary", id: "api-secret-done", guard: stored ? null : { allowed: false, reason: "Confirm you stored the key first.", needs: "" }, onClick: () => { if (stored) close(); else ui.toast("Confirm you stored the key first.", "warn"); } }]}
    />
  );
}

export function CreateKey({ d, close, onCreated }: { d: ApiData; close: () => void; onCreated: (k: ApiKey) => void }) {
  const out = useOutcome();
  const ui = useUI();
  const prefs = usePrefs();
  const [name, setName] = useState("");
  const [project, setProject] = useState(() => (prefs.project && d.visIds.includes(prefs.project) ? prefs.project : d.vis[0]?.id ?? ""));
  const [actions, setActions] = useState<string[]>(["wo.submit", "wo.read"]);
  const [days, setDays] = useState("90");
  const [err, setErr] = useState("");
  const perm = dec(useCan("api.keys", { project }));
  const submit = async () => {
    if (!name.trim()) { setErr("Name the key."); return; }
    if (!actions.length) { setErr("Pick at least one scope."); return; }
    const r = await ops.createKey({ name: name.trim(), project, actions, expiresInDays: Number(days) });
    if (!r.ok) { setErr(r.msg); out(r); return; }
    close();
    const key = (r as unknown as { key: ApiKey; secret: string }).key;
    const secret = (r as unknown as { secret: string }).secret;
    ui.open((c) => <SecretDialog k={key} secret={secret} project={d.pname(key.project)} close={c} />);
    onCreated(key);
  };
  return (
    <Dialog
      title="Create an API key" kicker="API & triggers" onClose={close}
      sub="Each key is a service account on one project. Work it submits is recorded against the key and the person who created it."
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what={`API keys on ${d.pname(project)}`} />
          <Field label="Name" htmlFor="api-key-name" hint="Name the system that will hold the key. It shows in the request log and audit.">
            <input id="api-key-name" className="input" placeholder="ServiceNow bridge" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Project" htmlFor="api-key-project" hint="A key works on one project only.">
            <Select id="api-key-project" options={d.vis.map((p) => ({ value: p.id, label: p.name }))} value={project} onChange={setProject} />
          </Field>
          <fieldset className="api-fs">
            <legend className="field-label">Scope</legend>
            <div className="check-grid">
              {KEY_ACTIONS.map(([id, label]) => {
                const cid = `api-key-act-${id.replace(".", "-")}`;
                return (
                  <label key={id} className="check" htmlFor={cid}>
                    <input type="checkbox" id={cid} checked={actions.includes(id)} onChange={(e) => setActions((a) => (e.target.checked ? [...a.filter((x) => x !== id), id] : a.filter((x) => x !== id)))} />
                    <span>{label} <span className="mono small muted">{id}</span></span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <Field label="Expires" htmlFor="api-key-expires" hint="Keys stop working on their own. Rotate before then.">
            <Select id="api-key-expires" options={EXPIRY} value={days} onChange={setDays} />
          </Field>
          <div className="form-err" role="alert">{err}</div>
        </div>
      )}
      actions={[{ label: "Cancel" }, { label: "Create key", kind: "primary", submit: true, id: "api-key-go", guard: perm, onClick: () => void submit() }]}
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

function RevokeBtn({ k }: { k: ApiKey }) {
  const ui = useUI();
  const perm = dec(useCan("api.keys", { project: k.project }));
  return <Btn label="Revoke" small kind="danger" id={`api-key-revoke-${k.id}`} guard={perm} onClick={() => ui.open((c) => <RevokeKey k={k} perm={perm} close={c} />)} />;
}

export function KeysTab({ d, onCreated }: { d: ApiData; onCreated: (k: ApiKey) => void }) {
  const ui = useUI();
  const who = useActors();
  const guard = useCanAny("api.keys", d.vis);
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const keys = [...d.keys].sort((a, b) => Number(a.revoked) - Number(b.revoked) || b.created - a.created).filter((k) => !needle || `${k.name} ${k.prefix} ${d.pname(k.project)}`.toLowerCase().includes(needle));
  return (
    <div className="form-grid">
      <FilterBar label="Filter keys" count={`${keys.length} of ${d.keys.length}`} actions={<Btn label="Create key" kind="primary" icon="plus" id="api-key-new" guard={guard} onClick={() => ui.open((c) => <CreateKey d={d} close={c} onCreated={onCreated} />)} />}>
        <SearchBox id="api-key-q" label="Search keys" placeholder="Search keys" value={q} onChange={setQ} />
      </FilterBar>
      <DataTable
        id="api-keys"
        caption="API keys"
        rows={keys}
        rowKey={(k) => k.id}
        rowId={(k) => `api-key-row-${k.id}`}
        pageSize={10}
        empty={{ title: d.keys.length ? "No key matches" : "No keys on your projects", text: d.keys.length ? "Change the search." : "Create a key to let another system submit work." }}
        columns={[
          { key: "name", label: "Name", render: (k) => <><b className="ell">{k.name}</b><div className="small dim">{`by ${who(k.by).name}`}</div></> },
          { key: "prefix", label: "Key", render: (k) => <span className="mono">{k.prefix}…</span> },
          { key: "project", label: "Project", render: (k) => <span className="tag">{d.pname(k.project)}</span> },
          { key: "actions", label: "Actions", hideSmall: true, render: (k) => <>{k.actions.map((a) => <span key={a} className="tag">{a}</span>)}</> },
          { key: "lastUsed", label: "Last used", render: (k) => <span className="mono dim">{k.lastUsed ? fmt.ago(k.lastUsed, Date.now()) : "never"}</span> },
          { key: "created", label: "Created", hideSmall: true, render: (k) => <span className="mono dim">{fmt.istDate(k.created)}</span> },
          { key: "status", label: "Status", render: (k) => <>{k.revoked ? <span className="chip idle">Revoked</span> : k.expired ? <span className="chip idle">Expired</span> : <span className="chip ok">Active</span>}{!k.revoked && k.expires ? <div className="small dim">{k.expired ? "expired " : "expires "}{fmt.istDate(k.expires)}</div> : null}</> },
          { key: "act", label: "", align: "end", render: (k) => (k.revoked ? null : <RevokeBtn k={k} />) },
        ]}
      />
    </div>
  );
}
