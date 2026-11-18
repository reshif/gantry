/**
 * The chat's settings, opened from its header as a popover next to the button: the model that answers, what the console may do for this person
 * (each with its permission code) and the audit link. Never a panel below the fold.
 */
import { navigate } from "../../lib/router";
import { Btn } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { useConsoleStatus } from "./api";
import { ModelPicker } from "./ModelPicker";

function SettingsBody({ project, close }: { project: string | null; close: () => void }) {
  const status = useConsoleStatus(project);
  const st = status.data;
  const go = (id: string, param?: string): void => { close(); navigate(id, param); };
  if (!st) return <p className="small muted cc-settings" id="con-settings-body">{status.isError ? "The console settings could not be loaded." : "Loading settings."}</p>;
  const noModels = st.models !== undefined && !st.models.length;
  return (
    <div className="cc-settings" id="con-settings-body">
      <p className="small" id="con-mode-reason">
        {st.configured ? `Answers come from ${st.model} (${st.vendor}) using tools over the live factory.` : noModels ? (st.canManageModels ? "No model can be called yet." : "No model can be called yet. Ask a Factory Admin to connect a model vendor in Models.") : (st.reason ?? "The console could not check its model.")}
      </p>
      {st.models?.length ? <ModelPicker st={st} /> : null}
      {noModels && st.canManageModels ? <a href="#models" id="con-connect-vendor" onClick={(e) => { e.preventDefault(); go("models"); }}>Connect a model vendor</a> : null}
      <h3 className="kicker">What the console may do for you</h3>
      <ul className="caps" id="con-rights">
        {(st.proposals ?? []).map((p) => <li key={p.kind} id={`con-right-${p.kind}`} className={p.allowed ? "ok" : "no"} title={p.reason}><Icon name={p.allowed ? "check" : "lock"} /><span>{`Propose: ${p.does}`}</span><code className="cap-code mono" title="The permission code that governs this. Admins find it under Govern, Access.">{p.right}</code></li>)}
      </ul>
      {st.proposals && !st.proposals.some((p) => p.allowed) ? <p className="muted small" id="con-readonly">Your console is read-only: it can answer questions but not propose changes.</p> : null}
      <div className="row gap-sm">
        <Btn small icon="shield" label="Open in the audit log" id="con-open-audit" onClick={() => go("audit", "console")} />
        {st.isFactoryAdmin ? <Btn small label="Console permissions" id="con-manage-perms" onClick={() => go("access")} /> : null}
      </div>
    </div>
  );
}

export function SettingsButton({ project }: { project: string | null }) {
  const ui = useUI();
  return (
    <Btn small icon="tool" label="Settings" id="con-settings" aria-haspopup="dialog"
      onClick={(e) => { const a = e.currentTarget; ui.popover(a, (close) => <SettingsBody project={project} close={close} />, undefined, { width: 380, align: "right", role: "dialog", label: "Console settings" }); }} />
  );
}
