/** The Connected, Catalogue and Custom builder tabs, in the Blueprint prototype's markup (cards, a flush catalogue table, one builder panel). */
import { useState } from "react";
import { INTEGRATION_CATEGORIES, type IntegrationInstance } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Empty, Field, LockNote, Panel, Select, type Decision } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { ListView, ago } from "../connect/kit";
import { catName, keyOf, slug, statusOf, useIntegrationData, type TypeRow } from "./kit";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

export function ConnectedTab({ openInstance, onToggle }: { openInstance: (id: string) => void; onToggle: (i: IntegrationInstance) => void }) {
  const d = useIntegrationData();
  const ui = useUI();
  const perm = dec(useCan("integration.edit"));
  const rows = d.insts;
  const test = async (i: IntegrationInstance): Promise<void> => {
    const t0 = Date.now();
    const r = await ops.testIntegrationInstance(i.id);
    const out = (r as { test?: { ok?: boolean; ms?: number } }).test;
    const ok = r.ok && (out?.ok ?? true);
    // the latency is the connector's own figure when it reports one, else the measured round trip of the test call
    ui.toast(ok ? `${i.name}: connection OK, ${typeof out?.ms === "number" ? out.ms : Date.now() - t0} ms` : r.msg, ok ? "ok" : "error");
  };
  return (
    <div className="stack">
      {!rows.length ? (
        <Empty title="Nothing connected" text="Connect an integration from the Catalogue tab." />
      ) : (
        <div className="card-grid" id="int-table">
          {rows.map((i) => {
            const t = d.typeOf(i);
            const st = statusOf(i);
            const tone = st === "healthy" ? "ok" : st === "failing" || st === "disabled" ? "bad" : "plain";
            const cfg = Object.entries(i.config).filter(([k, v]) => v !== undefined && v !== "" && t.fields.find((f) => f.key === k)?.type !== "secret").slice(0, 2);
            const scope = i.projects === "all" ? "All projects" : i.projects.map(d.pname).join(", ");
            return (
              <div className="card" key={i.id} data-key={i.id}>
                <div className="row">
                  <h3><button type="button" className="linkish int-name-btn" id={`int-open-${i.id}`} onClick={() => openInstance(i.id)}>{i.name}</button></h3>
                  <span className="spacer" />
                  <span className={`chip ${tone}`}>{i.connected ? (st === "unknown" ? "not tested yet" : st) : "disconnected"}</span>
                </div>
                <div className="small muted">{t.name} · {catName(t.category)}</div>
                <dl className="kv int-card-kv">
                  <dt>Scope</dt><dd>{scope}</dd>
                  <dt>Last sync</dt><dd>{ago(i.lastSync)}</dd>
                  {cfg.map(([k, v]) => [<dt key={`${k}-t`}>{t.fields.find((f) => f.key === k)?.label ?? k}</dt>, <dd key={`${k}-d`}>{typeof v === "boolean" ? <span className="small">{v ? "Yes" : "No"}</span> : <span className="mono small">{String(v)}</span>}</dd>])}
                  <dt>Secret</dt><dd>{i.secretMask}</dd>
                </dl>
                <div className="row">
                  <Btn label="Test" small id={`int-test-${i.id}`} guard={perm} onClick={() => void test(i)} />
                  <Btn label={i.connected ? "Disconnect" : "Reconnect"} small id={`int-toggle-${i.id}`} guard={perm} onClick={() => onToggle(i)} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CatalogueTab({ onRemove, onAdd, goBuild }: { onRemove: (id: string) => void; onAdd: (id: string) => void; goBuild: () => void }) {
  const d = useIntegrationData();
  const perm = dec(useCan("integration.add"));
  return (
    <Panel title="Available integrations" flush id="int-cat">
      <ListView<TypeRow>
        id="cat" noun="integration" rows={d.types} text={(t) => `${t.name} ${catName(t.category)}`}
        rowKey={(t) => t.id}
        filters={[{ key: "category", label: "Category", options: INTEGRATION_CATEGORIES.map((c) => [c.id, c.name] as [string, string]) }]}
        empty={<Empty id="int-cat-empty" title="No types yet" text="Build a custom integration to start." action={<Btn label="Build custom integration" small id="int-cat-build" onClick={goBuild} />} />}
        columns={[
          { key: "n", label: "Integration", sort: (t) => t.name.toLowerCase(), render: (t) => (
            <div><b>{t.name}</b><span className="sub">{catName(t.category)} · {t.auth} auth</span></div>
          ) },
          { key: "d", label: "Direction", render: (t) => <div className="row">{t.source ? <span className="chip info">source</span> : null}{t.destination ? <span className="chip plain">destination</span> : null}{t.custom ? <span className="chip plain">custom</span> : null}</div> },
          { key: "c", label: "Connected", align: "end", render: (t) => d.insts.filter((i) => i.type === t.id).length || "\u2014" },
          { key: "a", label: "", align: "end", render: (t) => (
            <span className="row">
              {t.custom ? <Btn small kind="ghost" cls="icon" icon="trash" aria={`Remove ${t.name} from the catalogue`} id={`int-cat-rm-${t.id}`} guard={perm} onClick={() => onRemove(t.id)} /> : null}
              <Btn label="Connect" small id={`int-cat-add-${t.id}`} guard={t.available === false ? { allowed: false, reason: t.unavailableReason ?? "Not yet available." } : perm} onClick={() => onAdd(t.id)} />
            </span>
          ) },
        ]}
      />
    </Panel>
  );
}

const AUTH4 = ["token", "basic", "oauth", "hmac"];
const list = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);

/**
 * The prototype's builder defines a webhook type from five answers: Name, Category, Auth, Base URL, Extra fields. The rest of what the server
 * needs is derived, not asked: it is a signed webhook in and templated HTTP out, so it gets an endpoint URL field (the Base URL is its placeholder),
 * a signing secret, and the extra fields as plain text fields.
 */
function builderDef(b: { name: string; category: string; auth: string; baseUrl: string; extra: string }) {
  const extras = list(b.extra).filter((x) => !["url", "secret"].includes(keyOf(x)));
  return {
    name: b.name.trim(), category: b.category, auth: b.auth, payload: "json", source: true, destination: true, targetLabel: "Target", icon: "plug",
    fields: [
      { key: "url", label: "Endpoint URL", type: "url", required: true, placeholder: b.baseUrl.trim() },
      { key: "secret", label: "Signing secret", type: "secret", required: true },
      ...extras.map((x) => ({ key: keyOf(x), label: x, type: "text", required: false })),
    ],
    events: ["kill", "andon", "released", "item.created"], actions: ["post_event"],
  };
}

export function CustomTab({ onDone }: { onDone: () => void }) {
  const ui = useUI();
  const d = useIntegrationData();
  const perm = dec(useCan("integration.add"));
  const ro = !perm.allowed;
  const [b, setB] = useState({ name: "", category: "source", auth: "token", baseUrl: "", extra: "token" });
  const [tried, setTried] = useState(false);
  const upd = (patch: Partial<typeof b>) => setB((x) => ({ ...x, ...patch }));
  const nameErr = !b.name.trim() ? "Name is required." : b.name.trim().length < 3 ? "Name needs at least 3 characters." : d.types.some((t) => t.id === slug(b.name)) ? "An integration type with this name exists." : "";
  const urlErr = !b.baseUrl.trim() ? "Base URL is required." : !/^https:\/\//.test(b.baseUrl.trim()) ? "Use an https:// URL." : "";
  const save = async () => {
    setTried(true);
    if (nameErr || urlErr) return;
    const def = builderDef(b);
    const r = await ops.addIntegrationType(def);
    if (!r.ok) return ui.toast(r.msg, "error");
    ui.toast(`${def.name} added to the catalogue`, "ok");
    setB({ name: "", category: "source", auth: "token", baseUrl: "", extra: "token" });
    setTried(false);
    onDone();
  };
  return (
    <Panel title="Define a custom webhook integration" id="int-builder">
      <form className="int-builder" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <LockNote decision={perm} what="Custom integration types" />
        <Field label="Name (required)" htmlFor="int-b-name" error={tried ? nameErr : undefined}><input id="int-b-name" className="input" value={b.name} disabled={ro} onChange={(e) => upd({ name: e.target.value })} /></Field>
        <Field label="Category" htmlFor="int-b-cat"><Select id="int-b-cat" options={INTEGRATION_CATEGORIES.map((c) => ({ value: c.id, label: c.name }))} value={b.category} disabled={ro} onChange={(v) => upd({ category: v })} /></Field>
        <Field label="Auth" htmlFor="int-b-auth"><Select id="int-b-auth" options={AUTH4} value={b.auth} disabled={ro} onChange={(v) => upd({ auth: v })} /></Field>
        <Field label="Base URL (required)" htmlFor="int-b-url" error={tried ? urlErr : undefined}><input id="int-b-url" className="input" value={b.baseUrl} disabled={ro} onChange={(e) => upd({ baseUrl: e.target.value })} /></Field>
        <Field label="Extra fields (comma separated)" htmlFor="int-b-extra" hint="Each becomes a field when someone connects it."><input id="int-b-extra" className="input" value={b.extra} disabled={ro} onChange={(e) => upd({ extra: e.target.value })} /></Field>
        <div><Btn label="Add to catalogue" kind="primary" type="submit" id="int-b-save" guard={perm} /></div>
      </form>
    </Panel>
  );
}
