/** Vendor and model dialogs (legacy connectDialog, disconnectDialog, addVendorDialog, addModelDialog, removeModelDialog). Every action is a real command; refusals show the server's reason. */
import { useState } from "react";
import type { Agent, Model, Routing, Vendor } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Callout } from "./Callout";
import { Field, LockNote, Select } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { RETENTION, allModels, dec, hasEndpoint, no } from "./kit";

const REGIONS = ["eu-central-1", "eu-west-1", "us-east-1", "us-west-2", "ap-south-1"];

export function ConnectDialog({ v, close }: { v: Vendor; close: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const isLocal = hasEndpoint(v);
  const [runtime, setRuntime] = useState(v.product);
  const [key, setKey] = useState("");
  const [region, setRegion] = useState(v.region || REGIONS[0]!);
  const [endpoint, setEndpoint] = useState(v.endpoint);
  const [budget, setBudget] = useState(String(v.budget || (isLocal ? 0 : 1000)));
  const [retention, setRetention] = useState(v.retention ?? "standard");
  const [err, setErr] = useState("");
  const off = !perm.allowed;

  const submit = async () => {
    const k = key.trim();
    if (!isLocal && (k ? k.length < 8 : !v.connected)) return setErr("Enter the full key (at least 8 characters).");
    if (endpoint && !(v.custom ? /^https:\/\/\S+$/ : /^https?:\/\/\S+$/).test(endpoint.trim())) return setErr(v.custom ? "Endpoint must start with https://" : "Endpoint must start with http:// or https://");
    const patch: Record<string, unknown> = { budget: +budget || 0, retention };
    if (k) patch.key = k;
    if (v.id === "bedrock") patch.region = region;
    if (isLocal) patch.endpoint = endpoint.trim();
    if (v.id === "local") patch.product = runtime;
    if (!v.connected) patch.connected = true;
    const r = await ops.setVendor(v.id, patch, v.connected ? "vendor.update" : "vendor.connect");
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (r.ok) close();
    else setErr(r.msg);
  };

  return (
    <Dialog title={`${v.connected ? "Update " : "Connect "}${v.name}`} kicker="Models · vendor" onClose={close}
      sub="The key is sealed with the data key and shown masked from now on. Only the model gateway reads it, at call time. Whether the vendor answers is known from real calls, not from a test."
      actions={[
        { label: "Cancel" },
        { label: v.connected ? "Save" : "Connect", kind: "primary", submit: true, id: "vc-submit", guard: perm, onClick: () => void submit() },
      ]}
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what="Vendor settings" />
          {v.id === "local" ? (
            <Field label="Runtime" htmlFor="vc-runtime"><Select id="vc-runtime" disabled={off} options={[{ value: "vLLM endpoint", label: "vLLM (OpenAI-compatible)" }, { value: "Ollama", label: "Ollama" }]} value={runtime} onChange={setRuntime} /></Field>
          ) : null}
          {isLocal ? (
            <Field label="Endpoint URL" htmlFor="vc-endpoint" hint="OpenAI-compatible endpoint inside your network.">
              <input id="vc-endpoint" className="input mono" value={endpoint} disabled={off} placeholder="http://host:8000/v1" onChange={(e) => setEndpoint(e.target.value)} />
            </Field>
          ) : null}
          <Field label={isLocal ? "Token" : "API key"} htmlFor="vc-key" hint={v.keyMask ? `Current: ${v.keyMask}. Leave empty to keep it.` : undefined}>
            <input id="vc-key" className="input mono" type="password" autoComplete="off" value={key} disabled={off} placeholder={isLocal ? "Optional bearer token" : v.id === "bedrock" ? "Access key id and secret, or role ARN" : "API key"} onChange={(e) => setKey(e.target.value)} />
          </Field>
          {v.id === "bedrock" ? (
            <Field label="Region" htmlFor="vc-region" hint="Bedrock requests are pinned to this region. Residency rules in routing rely on it."><Select id="vc-region" disabled={off} options={REGIONS} value={region} onChange={setRegion} /></Field>
          ) : null}
          <div className="form-row">
            <Field label="Monthly budget (USD)" htmlFor="vc-budget" hint={isLocal ? "Use 0 for on-prem with no per-token cost." : "Alerts at 80% and 100%."}>
              <input id="vc-budget" className="input mono" type="number" min="0" step="100" value={budget} disabled={off} onChange={(e) => setBudget(e.target.value)} />
            </Field>
            <Field label="Data retention" htmlFor="vc-retention" hint="Projects can allow only some retention modes."><Select id="vc-retention" disabled={off} options={RETENTION} value={retention} onChange={setRetention} /></Field>
          </div>
          <div className="form-err" role="alert">{err}</div>
        </div>
      )} />
  );
}

export function DisconnectDialog({ v, routing, agents, close }: { v: Vendor; routing: Routing; agents: Agent[]; close: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const ids = v.models.map((m) => m.id);
  const primaries = agents.filter((a) => ids.includes(a.model));
  const isDefault = ids.includes(routing.defaultModel);
  const guard = !perm.allowed ? perm : isDefault ? no(`The factory default model is on ${v.name}. Pick another default in the routing policy first.`) : null;
  return (
    <Dialog title={`Disconnect ${v.name}`} kicker="Models · vendor" onClose={close} sub="Requests stop at once and the key is removed from the vault. You can reconnect later."
      actions={[
        { label: "Cancel" },
        { label: "Disconnect", kind: "danger", id: "vd-submit", guard, onClick: (c) => void (async () => {
          const r = await ops.setVendor(v.id, { connected: false }, "vendor.disconnect");
          ui.toast(r.msg, r.ok ? "ok" : "error");
          if (r.ok) c();
        })() },
      ]}
      body={(
        <div className="form-grid">
          <LockNote decision={guard ?? perm} what="Disconnecting" />
          {primaries.length ? (
            <Callout warn icon="alert">{`${primaries.map((a) => a.name).join(", ")} use a ${v.name} model as primary. Calls for those models fall back to the same model on another allowed vendor, or are refused.`}</Callout>
          ) : <p className="small muted">No agent uses this vendor as its primary model.</p>}
        </div>
      )} />
  );
}

export function ManualVendorDialog({ close, onAdded }: { close: () => void; onAdded: (id: string) => void }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [key, setKey] = useState("");
  const [region, setRegion] = useState("");
  const [retention, setRetention] = useState("standard");
  const [err, setErr] = useState("");
  const off = !perm.allowed;
  const submit = async () => {
    if (!name.trim()) return setErr("Name the vendor.");
    if (endpoint.trim() && !/^https:\/\//.test(endpoint.trim())) return setErr("Endpoint must start with https://.");
    const r = await ops.addVendor({ name: name.trim(), ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}), ...(key.trim() ? { key: key.trim() } : {}), ...(region.trim() ? { region: region.trim() } : {}), retention });
    if (!r.ok) return setErr(r.msg);
    ui.toast(r.msg, "ok");
    close();
    const id = (r as unknown as { vendor?: { id: string } }).vendor?.id;
    if (id) onAdded(id);
  };
  return (
    <Dialog title="Add a vendor by hand" kicker="Models · vendor" wide onClose={close}
      sub="Any service that speaks the Anthropic or OpenAI-style messages API can be added. The key is sealed. A custom vendor is not qualified for any station until that station's eval suite has passed on it."
      actions={[{ label: "Cancel" }, { label: "Add vendor", kind: "primary", submit: true, id: "va-ok", guard: perm, onClick: () => void submit() }]}
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what="Vendors" />
          <Field label="Vendor name" htmlFor="va-name"><input id="va-name" className="input" value={name} disabled={off} placeholder="e.g. Mistral, Together, in-house gateway" onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Messages API endpoint URL" htmlFor="va-endpoint" hint="Must start with https://. Without an endpoint the vendor is added but cannot be connected.">
            <input id="va-endpoint" className="input mono" value={endpoint} disabled={off} placeholder="https://llm.example.com/v1" onChange={(e) => setEndpoint(e.target.value)} />
          </Field>
          <div className="form-row">
            <Field label="API key" htmlFor="va-key" hint="Without a key the vendor is added but not connected."><input id="va-key" className="input mono" type="password" autoComplete="off" value={key} disabled={off} placeholder="API key (optional now, needed to connect)" onChange={(e) => setKey(e.target.value)} /></Field>
            <Field label="Region or location" htmlFor="va-region" hint="Shown to people writing residency rules."><input id="va-region" className="input mono" value={region} disabled={off} placeholder="e.g. eu-west-1 or on-prem Pune" onChange={(e) => setRegion(e.target.value)} /></Field>
          </div>
          <Field label="Data retention" htmlFor="va-retention"><Select id="va-retention" disabled={off} options={RETENTION} value={retention} onChange={setRetention} /></Field>
          <div className="form-err" role="alert">{err}</div>
        </div>
      )} />
  );
}

export function AddModelDialog({ v, vendors, close }: { v: Vendor; vendors: Vendor[]; close: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const [name, setName] = useState("");
  const [mid, setMid] = useState("");
  const [pin, setPin] = useState("0");
  const [pout, setPout] = useState("0");
  const [ctx, setCtx] = useState("128000");
  const [tier, setTier] = useState("standard");
  const [same, setSame] = useState("");
  const [err, setErr] = useState("");
  const off = !perm.allowed;
  const others = allModels(vendors).filter((m) => m.vendor !== v.id);
  const submit = async () => {
    if (!name.trim()) return setErr("Name the model.");
    const canonical = others.find((m) => m.id === same)?.canonical;
    const r = await ops.addModel(v.id, { ...(mid.trim() ? { id: mid.trim() } : {}), name: name.trim(), inPrice: pin, outPrice: pout, context: ctx, tier, ...(canonical ? { canonical } : {}) });
    if (!r.ok) return setErr(r.msg);
    ui.toast(r.msg, "ok");
    close();
  };
  return (
    <Dialog title={`Add a model to ${v.name}`} kicker="Models · catalogue" onClose={close}
      sub="Prices are USD per million tokens and start a new price version. New models start enabled; nothing routes to them until an agent or routing rule picks them."
      actions={[{ label: "Cancel" }, { label: "Add model", kind: "primary", submit: true, id: "ma-ok", guard: perm, onClick: () => void submit() }]}
      body={(
        <div className="form-grid">
          <LockNote decision={perm} what="Models" />
          <div className="form-row">
            <Field label="Name" htmlFor="ma-name"><input id="ma-name" className="input" value={name} disabled={off} placeholder="e.g. Llama 4 70B Instruct" onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Model id" htmlFor="ma-id"><input id="ma-id" className="input mono" value={mid} disabled={off} placeholder="model id sent to the API (from the name if empty)" onChange={(e) => setMid(e.target.value)} /></Field>
          </div>
          <div className="form-row">
            <Field label="Input $ / Mtok" htmlFor="ma-in"><input id="ma-in" className="input mono" type="number" min="0" step="0.01" value={pin} disabled={off} onChange={(e) => setPin(e.target.value)} /></Field>
            <Field label="Output $ / Mtok" htmlFor="ma-out"><input id="ma-out" className="input mono" type="number" min="0" step="0.01" value={pout} disabled={off} onChange={(e) => setPout(e.target.value)} /></Field>
            <Field label="Context (tokens)" htmlFor="ma-ctx"><input id="ma-ctx" className="input mono" type="number" min="1000" step="1000" value={ctx} disabled={off} onChange={(e) => setCtx(e.target.value)} /></Field>
            <Field label="Tier" htmlFor="ma-tier"><Select id="ma-tier" disabled={off} options={[{ value: "fast", label: "Fast" }, { value: "standard", label: "Standard" }, { value: "frontier", label: "Frontier" }]} value={tier} onChange={setTier} /></Field>
          </div>
          <Field label="Same model as (optional)" htmlFor="ma-same" hint="Marks this as the same model another vendor serves, so calls can fall back between them.">
            <Select id="ma-same" disabled={off} options={[{ value: "", label: "A different model" }, ...others.map((m) => ({ value: m.id, label: `${m.name} · ${m.vendorName}` }))]} value={same} onChange={setSame} />
          </Field>
          <div className="form-err" role="alert">{err}</div>
        </div>
      )} />
  );
}

export function RemoveModelDialog({ v, m, close }: { v: Vendor; m: Model; close: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  return (
    <Dialog title={`Remove ${m.name}`} kicker={`Models · ${v.name}`} onClose={close} sub="Removes the model from the catalogue. No agent or routing rule uses it. Audited."
      actions={[
        { label: "Cancel" },
        { label: "Remove model", kind: "danger", id: "md-rm-ok", guard: perm, onClick: (c) => void (async () => {
          const r = await ops.removeModel(m.id);
          ui.toast(r.msg, r.ok ? "ok" : "error");
          if (r.ok) c();
        })() },
      ]}
      body={<div className="form-grid"><LockNote decision={perm} what="Models" /><p className="small mono">{m.id}</p></div>} />
  );
}
