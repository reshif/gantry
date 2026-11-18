/** The Keys tab (legacy keysTab, createKeyDialog, secretDialog and the revoke dialog): service accounts scoped to one project and a set of actions, shown once at creation. */
import { useEffect, useState } from "react";
import { DAY, fmt } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { api, get } from "../../api/client";
import { DataTable } from "../../ui/DataTable";
import { Btn, Field, FilterBar, LockNote, SearchBox, Select, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { CrIcon } from "../../ui/cr";
import { useCopy } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { useActors } from "../../ui/actors";
import { usePrefs } from "../../lib/prefs";
import { useOutcome } from "../govern/data";
import { agoShort } from "../connect/kit";
import { KEY_ACTIONS, dec, type ApiData } from "./kit";
import type { ApiKey } from "@gantry/domain";

const EXPIRY = [{ value: "30", label: "30 days" }, { value: "90", label: "90 days (default)" }, { value: "180", label: "180 days" }, { value: "365", label: "1 year" }];

export function SecretDialog({ k, secret, project, close }: { k: ApiKey; secret: string; project: string; close: () => void }) {
  const copy = useCopy();
  return (
    <Dialog
      title="Copy your key now" onClose={close}
      sub="It will not be shown again."
      body={(
        <div className="form-grid">
          <div className="banner warn"><CrIcon name="lock" /><div className="grow">Store it in your secret manager.</div></div>
          <div className="api-secret">
            <input id="api-secret-value" className="input mono" readOnly value={secret} aria-label="New API key" onFocus={(e) => e.target.select()} />
            <Btn label="Copy key" icon="copy" id="api-secret-copy" onClick={() => copy(secret)} />
          </div>
          <p className="muted small">Project <b>{project}</b>. Scope: <span className="mono">{k.actions.join(", ")}</span>. Shown later as <span className="mono">{k.prefix.replace(/…$/, "")}…</span>{k.expires ? <> Expires <span className="mono">{fmt.istDate(k.expires)}</span>.</> : null}</p>
        </div>
      )}
      actions={[{ label: "I have copied it", kind: "primary", id: "api-secret-done", onClick: () => close() }]}
    />
  );
}

export function CreateKey({ d, close, onCreated }: { d: ApiData; close: () => void; onCreated: (k: ApiKey) => void }) {
  const out = useOutcome();
  const ui = useUI();
  const prefs = usePrefs();
  const [name, setName] = useState("");
  const [project, setProject] = useState(() => (prefs.project && d.visIds.includes(prefs.project) ? prefs.project : d.vis[0]?.id ?? ""));
  const [preset, setPreset] = useState("rw");
  const [extra, setExtra] = useState<string[]>([]);
  const actions = [...(preset === "rw" ? ["wo.submit", "wo.read"] : ["wo.read"]), ...extra];
  const [days, setDays] = useState("90");
  const [err, setErr] = useState("");
  const perm = dec(useCan("api.keys", { project }));
  const submit = async () => {
    if (name.trim().length < 3) { setErr("Name must be at least 3 characters."); return; }
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
      title="Create API key" onClose={close} dirty={!!name}
            body={(
        <div className="form-grid">
          <LockNote decision={perm} what={`API keys on ${d.pname(project)}`} />
          <Field label="Name" htmlFor="api-key-name">
            <input id="api-key-name" className="input" placeholder="e.g. Release dashboard" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Project" htmlFor="api-key-project" >
            <Select id="api-key-project" options={d.vis.map((p) => ({ value: p.id, label: p.name }))} value={project} onChange={setProject} />
          </Field>
          <Field label="Actions" htmlFor="api-key-actions"><Select id="api-key-actions" options={[{ value: "rw", label: "Submit and read work orders" }, { value: "r", label: "Read only" }]} value={preset} onChange={setPreset} /></Field>
          <details className="int-more">
            <summary>More scopes</summary>
            <div className="check-grid">
              {KEY_ACTIONS.filter(([id]) => id !== "wo.submit" && id !== "wo.read").map(([id, label]) => {
                const cid = `api-key-act-${id.replace(".", "-")}`;
                return (
                  <label key={id} className="check" htmlFor={cid}>
                    <input type="checkbox" id={cid} checked={extra.includes(id)} onChange={(e) => setExtra((a) => (e.target.checked ? [...a.filter((x) => x !== id), id] : a.filter((x) => x !== id)))} />
                    <span>{label} <span className="mono small muted">{id}</span></span>
                  </label>
                );
              })}
            </div>
          </details>
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
      title={`Revoke ${k.name}?`} sub="Anything using this key stops working immediately. This cannot be undone." onClose={close}
      body={n === null ? <p className="muted small">Requests with this key fail with 401.</p> : <p className="muted small">It made {n} request{n === 1 ? "" : "s"} in the last 24 hours.</p>}
      actions={[{ label: "Cancel" }, { label: "Revoke key", kind: "danger", id: "api-key-revoke-go", guard: perm, onClick: async () => { const r = out(await ops.revokeKey(k.id)); if (r.ok) close(); } }]}
    />
  );
}

function RevokeBtn({ k }: { k: ApiKey }) {
  const ui = useUI();
  const perm = dec(useCan("api.keys", { project: k.project }));
  return <Btn label="Revoke" small kind="danger" id={`api-key-revoke-${k.id}`} guard={perm} onClick={() => ui.open((c) => <RevokeKey k={k} perm={perm} close={c} />)} />;
}

export function KeysTab({ d, url }: { d: ApiData; url: { v: { q: string; sort: string; dir: string; page: string }; set: (p: { q?: string; sort?: string; dir?: string; page?: string }) => void; clear: () => void } }) {
  const who = useActors();
  const needle = url.v.q.trim().toLowerCase();
  const keys = d.keys.filter((k) => !needle || `${k.name} ${k.prefix} ${d.vis.find((p) => p.id === k.project)?.key ?? k.project}`.toLowerCase().includes(needle));
  const pkey = (id: string): string => d.vis.find((p) => p.id === id)?.key ?? id;
  return (
    <>
      <FilterBar label="Filter keys" count={`${keys.length} of ${d.keys.length}`} actions={url.v.q ? <Btn label="Clear" small kind="ghost" id="api-key-clear" onClick={() => url.clear()} /> : null}>
        <SearchBox id="api-key-q" label="Search keys" placeholder="Search keys" value={url.v.q} onChange={(q) => url.set({ q })} />
      </FilterBar>
      <DataTable
        id="api-keys"
        caption="API keys"
        rows={keys}
        rowKey={(k) => k.id}
        rowId={(k) => `api-key-row-${k.id}`}
        pageSize={10}
        pager
        page={Math.max(0, Number(url.v.page) || 0)}
        onPage={(p) => url.set({ page: String(p) })}
        sort={{ key: url.v.sort || "created", dir: url.v.dir ? (url.v.dir === "asc" ? 1 : -1) : -1 }}
        onSort={(s) => url.set({ sort: s.key, dir: s.dir === 1 ? "asc" : "desc", page: "0" })}
        empty={d.keys.length ? { title: "Nothing matches", text: "Try clearing a filter or searching for something else.", action: <Btn label="Clear filters" id="clear-filters" onClick={() => url.clear()} /> } : { title: "No keys on your projects", text: "Create a key to let another system submit work." }}
        columns={[
          { key: "name", label: "Name", sort: (k) => k.name.toLowerCase(), render: (k) => <b className="ell" title={`Created by ${who(k.by).name}`}>{k.name}</b> },
          { key: "prefix", label: "Key", render: (k) => <span className="mono">{k.prefix.replace(/…+$/, "")}…</span> },
          { key: "project", label: "Project", sort: (k) => pkey(k.project), render: (k) => <span className="tag">{pkey(k.project)}</span> },
          { key: "actions", label: "Actions", hideSmall: true, render: (k) => <>{k.actions.map((a) => <span key={a} className="tag">{a}</span>)}</> },
          { key: "used", label: "Last used", sort: (k) => k.lastUsed ?? 0, render: (k) => <span className="mono dim">{agoShort(k.lastUsed)}</span> },
          { key: "created", label: "Created", hideSmall: true, sort: (k) => k.created, render: (k) => <span className="mono dim">{agoShort(k.created)}</span> },
          { key: "act", label: "", align: "end", render: (k) => (k.revoked ? <span className="chip idle">Revoked</span> : k.expired ? <span className="chip idle">Expired</span> : <RevokeBtn k={k} />) },
        ]}
      />
    </>
  );
}
