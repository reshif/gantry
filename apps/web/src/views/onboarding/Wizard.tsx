/** Connect-repo wizard (legacy onboarding.js connectWizard): repo, ownership, MCP, triggers, conventions, review. */
import { useEffect, useState } from "react";
import type { Project } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useMcpServers } from "../../api/queries";
import { Dialog } from "../../ui/Overlay";
import { Field, LockNote } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { draftFrom, orgOf, patchFrom, useAvailableRepos, useIntegrationsFor, useTeamName, type Draft, type RepoV } from "./kit";
import { SecConventions, SecMCP, SecOwnership, SecSource, SecTriggers } from "./Settings";

const WSTEPS = ["Repo", "Ownership", "MCP", "Triggers", "Conventions", "Review"];

export function ConnectWizard({ project, repos, close, onDone }: { project: Project; repos: RepoV[]; close: () => void; onDone: (repoId: string) => void }) {
  const ui = useUI();
  const dec = useCan("repo.onboard", { project: project.id });
  const teamName = useTeamName();
  const { sources, dests } = useIntegrationsFor(project.id);
  const mcp = useMcpServers().data;
  const [d, setD] = useState<Draft>(() => draftFrom(null, project, dests));
  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const avail = useAvailableRepos(project.id, step === 0);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  // The first repo the App can see is picked for you, as before; type another to change it.
  const first = avail.data?.available?.[0]?.repo ?? "";
  useEffect(() => { if (first) setD((x) => (x.name ? x : { ...x, name: first })); }, [first]);
  const src = sources.find((s) => s.inst.id === d.source)?.inst ?? null;
  const available = avail.data?.available ?? null;
  const org = orgOf(src);
  const fullName = (): string => {
    const n = d.name.trim();
    return n.includes("/") || !org ? n : `${org}/${n}`;
  };

  const validate = (): string | null => {
    if (step !== 0) return null;
    if (src && (src.status === "offline" || !src.connected)) return `${src.name} is offline. Pick another source or fix it under Integrations.`;
    const n = d.name.trim();
    if (!n) return "Pick or type a repo.";
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName())) return "Use the form org/name.";
    const ex = repos.find((r) => r.name.toLowerCase() === fullName().toLowerCase());
    if (ex) return `${fullName()} is already connected to ${project.name}.`;
    return null;
  };

  const next = async (done: () => void) => {
    const v = validate();
    if (v) return setErr(v);
    setErr("");
    if (step < WSTEPS.length - 1) return setStep(step + 1);
    setBusy(true);
    const x = await ops.connectRepo(project.id, fullName(), d.team, d.source || undefined);
    if (!x.ok) {
      setBusy(false);
      return setErr(x.msg);
    }
    const repo = (x as unknown as { repo: RepoV }).repo;
    const y = await ops.configureRepo(repo.id, patchFrom(d), repo.version !== undefined ? { ifMatch: repo.version } : undefined);
    setBusy(false);
    ui.toast(`${x.msg}${y.ok ? " Settings saved." : ` Settings not saved: ${y.msg}`}`, y.ok ? "ok" : "warn");
    done();
    onDone(repo.id);
  };

  let sec;
  if (step === 0) {
    sec = (
      <div className="form-grid">
        <div className="field">
          <div className="field-label">Where the repo lives</div>
          <SecSource d={d} set={(p) => set({ ...p, name: "" })} sources={sources} project={project} />
        </div>
        {available ? (
          <div className="field">
            <div className="field-label">Available from the GitHub App</div>
            {available.length ? (
              <div className="radio-cards onb-avail">
                {available.map((a, i) => (
                  <label key={a.repo} className="radio-card" htmlFor={`onb-w-av-${i}`}>
                    <input type="radio" name="onb-w-avail" id={`onb-w-av-${i}`} checked={d.name === a.repo} onChange={() => set({ name: a.repo })} />
                    <span className="rc-t mono">{a.repo}</span>
                    <span className="rc-d">{a.lang}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="muted small">Every repo the App can see is already connected.</p>
            )}
          </div>
        ) : avail.isLoading ? (
          <p className="muted small">Asking GitHub which repos the App can see…</p>
        ) : (
          <p className="muted small">{`${avail.data?.unavailable ?? "GitHub could not be asked for its repos."} Type the repo instead.`}</p>
        )}
        <Field label="Repo" htmlFor="onb-w-name" hint={available ? "Or type any repo the App is installed on." : `Type the repo as ${org || "org"}/name. The App must be installed on it.`}>
          <input id="onb-w-name" className="input mono" value={d.name} autoComplete="off" placeholder={`${org || "org"}/repo-name`} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <p className="muted small">{`It joins ${project.name}. Gantry assesses it as soon as it is connected.`}</p>
      </div>
    );
  } else if (step === 1) sec = <SecOwnership d={d} set={set} project={project} />;
  else if (step === 2) sec = <SecMCP d={d} set={set} />;
  else if (step === 3) sec = <SecTriggers d={d} set={set} project={project} />;
  else if (step === 4) sec = <SecConventions d={d} set={set} />;
  else {
    const p = patchFrom(d) as { notifyOverrides: unknown[]; config: { branchPrefix: string; defaultBranch: string; merge: string; requiredChecks: string[]; protectedPaths: string[] } };
    const mcpName = (id: string) => (Array.isArray(mcp) ? mcp : []).find((m) => m.id === id)?.name ?? id;
    const rows: Array<[string, React.ReactNode]> = [
      ["Repo", <span className="mono" key="r">{fullName()}</span>], ["Source", src?.name ?? "GitHub App"], ["Project", project.name], ["Owning team", teamName(d.team)],
      ["Notification overrides", String(p.notifyOverrides.length)], ["MCP servers", d.mcp.map(mcpName).join(", ") || "none"], ["Issue triggers", d.triggers ? "On" : "Off"],
      ["Branches", <span className="mono" key="b">{`${p.config.branchPrefix}* → ${p.config.defaultBranch}, ${p.config.merge}`}</span>],
      ["Required checks", <span className="mono" key="c">{p.config.requiredChecks.join(", ") || "none"}</span>], ["Protected paths", <span className="mono" key="pp">{p.config.protectedPaths.join(", ") || "none"}</span>],
    ];
    sec = (
      <dl className="onb-kvs">
        {rows.map(([k, v]) => (
          <div className="onb-kv" key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    );
  }

  return (
    <Dialog
      title={`Connect a repo to ${project.name}`} wide onClose={close}
      body={
        <div>
          <ol className="stepper onb-wsteps" aria-label="Steps">
            {WSTEPS.map((s, i) => (
              <li key={s} className={i === step ? "is-on" : i < step ? "is-done" : ""} aria-current={i === step ? "step" : undefined}>
                <span className="mono">{i < step ? "✓" : String(i + 1)}</span>
                {s}
              </li>
            ))}
          </ol>
          <LockNote decision={dec} what="Connecting repos" />
          {sec}
          <div className="form-err" role="alert">{err}</div>
        </div>
      }
      actions={[
        { label: "Cancel" },
        { label: "Back", id: "onb-w-back", ...(step === 0 ? { guard: { allowed: false, reason: "This is the first step" } } : {}), onClick: () => { if (step > 0) { setErr(""); setStep(step - 1); } } },
        { label: busy ? "Connecting…" : step === WSTEPS.length - 1 ? "Connect repo" : "Next", kind: "primary", submit: true, id: "onb-w-next", guard: dec, onClick: (done) => void next(done) },
      ]}
    />
  );
}
