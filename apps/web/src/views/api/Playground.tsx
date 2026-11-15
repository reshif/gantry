/**
 * The Playground tab (legacy playTab): submits a real work order through the public API with a key the person pastes, exactly as an external client would (no session cookie,
 * bearer only, Idempotency-Key header). Gantry keeps only each key's hash, so a key cannot be filled in for you: paste it.
 */
import { useState } from "react";
import { useCommand } from "../../ui/async";
import { classesOf, fmt } from "@gantry/domain";
import { invalidateSlices } from "../../api/keys";
import { useRepos } from "../../api/queries";
import { Btn, Empty, Field, LockNote, Panel, Select, type Decision } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { useOpenTraveler } from "../../shell/useTraveler";
import { usePrefs } from "../../lib/prefs";
import { useCatalog } from "../projects/kit";
import { StatusChip, type ApiData } from "./kit";

interface Last { at: number; status: number; ok: boolean; msg: string; response: unknown; wo: string | null }

/** A request as an external system would send it: bearer key only, no cookie, so a wrong key cannot sign anybody out of the app. */
export async function sendPublic(secret: string, project: string, body: Record<string, unknown>, idem: string): Promise<Last> {
  const at = Date.now();
  try {
    const res = await fetch(`/api/v1/projects/${encodeURIComponent(project)}/work-orders`, {
      method: "POST", credentials: "omit", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${secret}`, "Idempotency-Key": idem }, body: JSON.stringify(body),
    });
    let response: unknown = null;
    const text = await res.text();
    try { response = text ? JSON.parse(text) : null; } catch { response = text; }
    const r = (response && typeof response === "object" ? response : {}) as { msg?: string; id?: string };
    return { at, status: res.status, ok: res.ok, msg: r.msg || (res.ok ? "OK" : `Request failed (${res.status}).`), response, wo: res.ok && typeof r.id === "string" ? r.id : null };
  } catch {
    return { at, status: 0, ok: false, msg: "Could not reach Gantry.", response: { error: "network" }, wo: null };
  }
}

export function PlayTab({ d }: { d: ApiData }) {
  const ui = useUI();
  const prefs = usePrefs();
  const openTraveler = useOpenTraveler();
  const cat = useCatalog();
  const [f, setF] = useState({ secret: "", project: prefs.project && d.visIds.includes(prefs.project) ? prefs.project : d.vis[0]?.id ?? "", repo: "", cls: "", priority: "P2", title: "Retry failed payout webhooks with backoff", description: "Payout webhooks fail permanently after one 5xx. Retry with exponential backoff.", idem: "" });
  const [last, setLast] = useState<Last | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const reposQ = useRepos(f.project);
  const repos = reposQ.data ?? [];
  const project = d.vis.find((p) => p.id === f.project);
  const classes = cat && project ? classesOf(cat, project) : [];
  const repo = repos.some((r) => r.id === f.repo) ? f.repo : (repos.find((r) => r.onboarding?.stage === "ready") ?? repos[0])?.id ?? "";
  const cls = classes.some((c) => c.id === f.cls) ? f.cls : "";
  const prefix = f.secret.trim().slice(0, 11);
  const body: Record<string, unknown> = { repo, title: f.title, description: f.description, ...(cls ? { class: cls } : {}), priority: f.priority };
  const req = `POST /api/v1/projects/${f.project}/work-orders\nAuthorization: Bearer ${prefix ? `${prefix}…` : "(paste a key)"}\nContent-Type: application/json\nIdempotency-Key: ${f.idem || "(a fresh one per send)"}\n\n${JSON.stringify(body, null, 2)}`;
  const need: Decision | null = f.secret.trim().startsWith("gk_") ? null : { allowed: false, reason: "Paste a key from the Keys tab.", needs: "A key" };
  // the toast carries the HTTP status, so useCommand only guards against a double send
  const sendCmd = useCommand(sendPublic, { ok: false, toastFail: false });
  const busy = sendCmd.busy;
  const send = async () => {
    if (!f.title.trim()) { ui.toast("A title is required by the API.", "error"); return; }
    const r = await sendCmd.run(f.secret.trim(), f.project, body, f.idem || globalThis.crypto.randomUUID());
    if (!r) return;
    setLast(r);
    ui.toast(`${r.status} ${r.msg}`, r.ok ? "ok" : "error");
    invalidateSlices(["requestLog", ...(r.ok ? ["workOrders", "apiKeys"] : [])]);
  };
  return (
    <div className="api-play">
      <Panel title="Request">
        <div className="form-grid">
          <Field label="API key" htmlFor="api-pg-secret" hint="Gantry stores only a hash of each key, so it cannot fill this in for you. The request goes out as an external client would send it.">
            <input id="api-pg-secret" className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder="gk_…" value={f.secret} onChange={(e) => set("secret")(e.target.value)} />
          </Field>
          <div className="form-row">
            <Field label="Project in URL" htmlFor="api-pg-project" hint="Try another project to see a 403."><Select id="api-pg-project" options={d.vis.map((p) => ({ value: p.id, label: p.id }))} value={f.project} onChange={set("project")} /></Field>
            <Field label="repo" htmlFor="api-pg-repo"><Select id="api-pg-repo" options={repos.map((r) => ({ value: r.id, label: r.id + (r.onboarding?.stage === "ready" ? "" : " (not ready)") }))} value={repo} onChange={set("repo")} /></Field>
          </div>
          <div className="form-row">
            <Field label="class" htmlFor="api-pg-class"><Select id="api-pg-class" options={[{ value: "", label: "Let Intake decide" }, ...classes.map((c) => ({ value: c.id, label: c.id }))]} value={cls} onChange={set("cls")} /></Field>
            <Field label="priority" htmlFor="api-pg-prio"><Select id="api-pg-prio" options={["P1", "P2", "P3"]} value={f.priority} onChange={set("priority")} /></Field>
          </div>
          <Field label="title" htmlFor="api-pg-title"><input id="api-pg-title" className="input" value={f.title} onChange={(e) => set("title")(e.target.value)} /></Field>
          <Field label="description" htmlFor="api-pg-desc"><textarea id="api-pg-desc" className="input" rows={2} value={f.description} onChange={(e) => set("description")(e.target.value)} /></Field>
          <div className="api-idem">
            <Field label="Idempotency-Key header" htmlFor="api-pg-idem" hint="Send twice with the same key to get the original back. Left empty, each send gets a fresh key.">
              <input id="api-pg-idem" className="input mono" placeholder="optional" value={f.idem} onChange={(e) => set("idem")(e.target.value)} />
            </Field>
            <Btn label="Generate" small id="api-pg-idem-gen" onClick={() => set("idem")(`pg-${Date.now().toString(36)}`)} />
          </div>
          <pre className="api-pre mono" aria-label="Request preview">{req}</pre>
          <LockNote decision={need} what="Playground" />
          <div className="form-actions"><Btn label="Send request" kind="primary" icon="send" id="api-pg-send" guard={need} disabled={busy} onClick={() => void send()} /></div>
        </div>
      </Panel>
      <Panel title="Response">
        {last ? (
          <div className="form-grid" role="status">
            <div className="api-resline"><StatusChip code={last.status} /><span>{last.msg}</span><span className="muted small mono">{`${fmt.ist(last.at)} IST`}</span></div>
            <pre className="api-pre mono" id="api-pg-response">{JSON.stringify(last.response, null, 2)}</pre>
            {last.ok && last.wo ? <div className="form-actions"><Btn label={`Open ${last.wo}`} icon="chevron" id="api-pg-open" onClick={() => openTraveler(last.wo!)} /></div> : null}
          </div>
        ) : <Empty title="No request yet" text="Send the request to see the response. It goes through the same intake as the web form." />}
      </Panel>
    </div>
  );
}
