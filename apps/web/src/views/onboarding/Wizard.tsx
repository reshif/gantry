/** Connect-repo wizard (legacy onboarding.js connectWizard): repo, ownership, MCP, triggers, conventions, review. */
import { useEffect, useState } from "react";
import type { Project } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useMcpServers } from "../../api/queries";
import { Card } from "../../ui/cr";
import { Btn, Field, LockNote } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { draftFrom, orgOf, patchFrom, useAvailableRepos, useIntegrationsFor, useTeamName, type Draft, type RepoV } from "./kit";
import { SecConventions, SecMCP, SecOwnership, SecSource, SecTriggers } from "./Settings";

const WSTEPS = ["Repo", "Ownership", "MCP", "Triggers", "Conventions", "Review"];

export function ConnectWizard({ project, repos, onCancel, onDone }: { project: Project; repos: RepoV[]; onCancel: () => void; onDone: (repoId: string) => void }) {
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

  const next = async () => {
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
    setD(draftFrom(null, project, dests));
    setStep(0);
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
              <div className="list onb-avail" style={{ border: "1px solid var(--line)", borderRadius: 6 }}>
                {available.map((a, i) => (
                  <label key={a.repo} className="li click" htmlFor={`onb-w-av-${i}`}>
                    <input type="radio" className="cb" name="onb-w-avail" id={`onb-w-av-${i}`} checked={d.name === a.repo} onChange={() => set({ name: a.repo })} />
                    <span className="main1"><span className="t1 mono">{a.repo}</span><span className="t2">{`${a.lang} · default branch main`}</span></span>
                    <span className="tag">{a.lang}</span>
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

  const titles = ["Choose a repository", "Ownership", "MCP servers", "Triggers", "Conventions", "Review and connect"];
  return (
    <>
      <div className="wiz" role="list" aria-label="Steps">
        {WSTEPS.map((s, i) => (
          <span key={s} role="listitem" className={`w ${i === step ? "cur" : i < step ? "done" : ""}`} aria-current={i === step ? "step" : undefined}>
            <i>{i < step ? "✓" : String(i + 1)}</i>
            {s}
          </span>
        ))}
      </div>
      <Card title={titles[step] ?? ""} hint={step === 0 ? `Connected through ${src?.name ?? "the GitHub App"}` : undefined}>
        <LockNote decision={dec} what="Connecting repos" />
        {sec}
        <div className="form-err" role="alert">{err}</div>
      </Card>
      <div className="row spread" style={{ marginTop: 16 }}>
        <span className="row">
          <Btn label="Cancel" onClick={onCancel} />
          <Btn label="Back" id="onb-w-back" {...(step === 0 ? { guard: { allowed: false, reason: "This is the first step" } } : {})} onClick={() => { if (step > 0) { setErr(""); setStep(step - 1); } }} />
        </span>
        <Btn kind="primary" label={busy ? "Connecting…" : step === WSTEPS.length - 1 ? "Connect repo" : "Continue"} id="onb-w-next" guard={dec} onClick={() => void next()} />
      </div>
    </>
  );
}
