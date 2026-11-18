/**
 * The onboarding wizard in the prototype's four steps: Choose repo, Assessment, Guidelines, Pull request.
 * Continue on step 1 connects the repo (Gantry cannot assess a repo it has not connected); the assessment, the guideline notes and the
 * pull request are the real ones of that repo. Ownership, MCP, triggers and conventions stay in "Repo settings" (the Pipeline drawer).
 * The step state is held by the Onboarding screen, so it survives a switch of tab.
 */
import { useEffect } from "react";
import type { Project } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Card, CrIcon } from "../../ui/cr";
import { Btn, Chip, Field, Meter, Select } from "../../ui/primitives";
import { Input, TextArea } from "../../ui/inputs";
import { useUI } from "../../ui/overlay-context";
import { gaps, orgOf, useAvailableRepos, useIntegrationsFor, usePrFiles, type RepoV } from "./kit";

export interface Wiz {
  step: 1 | 2 | 3 | 4;
  repo: string;
  repoId: string | null;
  /** null: the notes box shows what the repo already has. */
  notes: string | null;
  tick: boolean;
  busy: boolean;
}
export const WIZ0: Wiz = { step: 1, repo: "", repoId: null, notes: null, tick: false, busy: false };
export const STEPS = ["Choose repo", "Assessment", "Guidelines", "Pull request"];

/** What the assessment says about one thing: the finding whose check name matches, in words; "not available" when the assessment has no such check. */
const NA = "not available";
function fact(r: RepoV | null, re: RegExp): string {
  const f = r?.onboarding.findings.find((x) => re.test(x.check));
  if (!f) return NA;
  return f.detail ?? (f.ok ? "Passes" : `Gap: ${f.fix}`);
}

export function OnbWizard({ project, repos, w, set, onDone }: { project: Project; repos: RepoV[]; w: Wiz; set: (p: Partial<Wiz>) => void; onDone: (repoId: string) => void }) {
  const ui = useUI();
  const dec = useCan("repo.onboard", { project: project.id });
  const merge = useCan("onboarding.merge", { project: project.id });
  const { sources } = useIntegrationsFor(project.id);
  const avail = useAvailableRepos(project.id, w.step === 1);
  const available = avail.data?.available ?? null;
  const src = sources[0]?.inst ?? null;
  const connected = repos.find((r) => r.id === w.repoId) ?? repos.find((r) => r.name === w.repo) ?? null;
  const pr = connected?.onboarding.pr ?? null;
  const files = usePrFiles(connected?.id ?? "", w.step === 4 && !!pr, `${pr?.number}`);
  const protectedPaths = connected?.config.protectedPaths ?? [];
  const sensitive = (path: string): boolean => /^\.github\/|(^|\/)CODEOWNERS$/.test(path) || protectedPaths.some((g) => path === g.replace(/\/?\*+$/, "") || path.startsWith(g.replace(/\*+$/, "")));
  useEffect(() => { if (connected && !w.repoId) set({ repoId: connected.id }); }, [connected, w.repoId]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = async () => {
    if (w.busy) return;
    if (w.step === 1) {
      if (!w.repo.trim()) return ui.toast("Choose a repository first.", "warn");
      if (!/^[\w.-]+\/[\w.-]+$/.test(w.repo.trim())) return ui.toast("Use the form org/name.", "warn");
      if (!connected) {
        set({ busy: true });
        const x = await ops.connectRepo(project.id, w.repo.trim(), project.teams[0] ?? "platform", src && src.type === "github" ? src.id : undefined);
        set({ busy: false });
        if (!x.ok) return ui.toast(x.msg, "error");
        const repo = (x as typeof x & { repo?: RepoV }).repo;
        ui.toast(`${w.repo.trim()} connected. Gantry is assessing it.`, "ok");
        return set({ repoId: repo?.id ?? null, step: 2 });
      }
      return set({ repoId: connected.id, step: 2 });
    }
    if (w.step === 2) return set({ step: 3 });
    if (w.step === 3) {
      if (connected && w.notes !== null && w.notes !== connected.guidelines) {
        set({ busy: true });
        const y = await ops.configureRepo(connected.id, { guidelines: w.notes }, connected.version !== undefined ? { ifMatch: connected.version } : undefined);
        set({ busy: false });
        if (!y.ok) return ui.toast(y.msg, "error");
      }
      return set({ step: 4 });
    }
    if (!connected) return;
    if (!pr) {
      set({ busy: true });
      const y = await ops.openOnboardingPR(connected.id);
      set({ busy: false });
      return ui.toast(y.msg, y.ok ? "ok" : "error");
    }
    if (!w.tick) return ui.toast("Tick the sensitive-files check first.", "warn");
    set({ busy: true });
    const y = await ops.mergeOnboardingPR(connected.id);
    set({ busy: false });
    if (!y.ok) return ui.toast(y.msg, "error");
    ui.toast(`${connected.name} is onboarded and ready.`, "ok");
    set({ ...WIZ0 });
    onDone(connected.id);
  };

  let inner;
  if (w.step === 1) {
    inner = (
      <Card title="Choose a repository" hint={`Connected through ${src?.name ?? "GitHub"}${orgOf(src) ? ` (${orgOf(src)})` : ""}`}>
        {available ? (
          available.length ? (
            <div className="list" style={{ border: "1px solid var(--line)", borderRadius: 6 }}>
              {available.map((a, i) => (
                <label key={a.repo} className="li click" htmlFor={`onb-w-av-${i}`}>
                  <Input type="radio" name="repo" id={`onb-w-av-${i}`} checked={w.repo === a.repo} onChange={() => set({ repo: a.repo })} />
                  <span className="main1"><span className="t1 mono">{a.repo}</span><span className="t2">{`${a.lang} · contributors not available`}</span></span>
                  <span className="tag">{a.lang}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="muted">Every repo the App can see is already connected.</p>
          )
        ) : (
          <p className="muted small">{avail.isLoading ? "Asking GitHub which repos the App can see…" : `${avail.data?.unavailable ?? "GitHub could not be asked for its repos."} Type the repo instead.`}</p>
        )}
        {available ? null : (
          <div style={{ marginTop: 12 }}>
            <Field label="Type a repo" htmlFor="onb-w-name" hint="As org/name. The GitHub App must be installed on it.">
              <Input id="onb-w-name" mono value={w.repo} autoComplete="off" placeholder="org/repo-name" onChange={(e) => set({ repo: e.target.value })} />
            </Field>
          </div>
        )}
      </Card>
    );
  } else if (w.step === 2) {
    const fs = connected?.onboarding.findings ?? [];
    const score = fs.length ? Math.round((fs.filter((f) => f.ok).length / fs.length) * 100) : null;
    const g = connected ? gaps(connected) : [];
    inner = (
      <Card title={`Assessment of ${w.repo}`}>
        <div className="grid g2">
          <dl className="kv">
            {([["Tests", /test/i], ["Coverage", /coverage/i], ["Flaky suites", /flak/i], ["CI", /\bci\b|workflow|checks/i], ["Secrets scan", /secret/i], ["Sensitive paths", /sensitive|protected|codeowners/i]] as Array<[string, RegExp]>).map(([k, re]) => {
              const v = fact(connected, re);
              return <div key={k}><dt>{k}</dt><dd className={v === NA ? "dim" : ""}>{v}</dd></div>;
            })}
          </dl>
          <div className="stack" style={{ gap: 12 }}>
            <div>
              <div className="row spread"><span>Readiness</span><b className="mono">{score === null ? NA : `${score} / 100`}</b></div>
              <Meter value={score ?? 0} max={100} label="Readiness" />
            </div>
            <div className={`banner ${g.length ? "warn" : ""}`}>
              <CrIcon name="warn" />
              <div className="grow">{score === null ? "Gantry is still assessing this repo. The figures appear as soon as it finishes." : g.length ? `${g.length} gap${g.length === 1 ? "" : "s"} found. The onboarding pull request can fix what has a file to change; you can fix the rest later.` : "No gaps found."}</div>
            </div>
          </div>
        </div>
      </Card>
    );
  } else if (w.step === 3) {
    inner = (
      <Card title="Guidelines">
        <div className="stack">
          <Field label="Guideline pack" htmlFor="onb-w-pack" hint="Packs are not available yet: the factory and project guidelines apply.">
            <Select id="onb-w-pack" disabled options={[{ value: "default", label: "Project default" }]} value="default" />
          </Field>
          <Field label="Extra repo notes for agents" htmlFor="onb-w-notes">
            <TextArea id="onb-w-notes" rows={4} value={w.notes ?? connected?.guidelines ?? ""} onChange={(e) => set({ notes: e.target.value })} />
          </Field>
        </div>
      </Card>
    );
  } else {
    const list = files.data?.files ?? [];
    inner = (
      <Card title="Onboarding pull request">
        {pr ? (
          <>
            <p style={{ marginBottom: 12 }}>{`The Onboarding Agent opened PR #${pr.number} on ${w.repo} with ${pr.files.length} file${pr.files.length === 1 ? "" : "s"}. Review, then approve the merge.`}</p>
            <div className="list" style={{ border: "1px solid var(--line)", borderRadius: 6 }}>
              {(list.length ? list.map((f) => f.path) : pr.files.map((f) => f.path)).map((p) => (
                <div key={p} className="li"><span className="mono" style={{ flex: 1 }}>{p}</span>{sensitive(p) ? <Chip text="Sensitive" cls="warn" /> : null}</div>
              ))}
            </div>
            <div className="stack" style={{ marginTop: 12 }}>
              <label className="switch" htmlFor="onb-w-tick"><Input type="checkbox" id="onb-w-tick" checked={w.tick} onChange={(e) => set({ tick: e.target.checked })} /><span>I checked the sensitive files (workflow and CODEOWNERS)</span></label>
            </div>
          </>
        ) : (
          <p className="muted">There is no onboarding pull request yet. Open it and the Onboarding Agent proposes the files this repo needs.</p>
        )}
      </Card>
    );
  }

  return (
    <>
      <div className="wiz" role="list" aria-label="Steps">
        {STEPS.map((t, i) => (
          <span key={t} role="listitem" className={`w ${i + 1 === w.step ? "cur" : i + 1 < w.step ? "done" : ""}`} aria-current={i + 1 === w.step ? "step" : undefined}>
            <i>{i + 1 < w.step ? "✓" : String(i + 1)}</i>
            {t}
          </span>
        ))}
      </div>
      {inner}
      <div className="row spread" style={{ marginTop: 16 }}>
        <Btn label="Back" id="onb-w-back" {...(w.step === 1 ? { disabled: true } : {})} onClick={() => set({ step: (w.step - 1) as Wiz["step"] })} />
        <Btn kind="primary" id="onb-w-next" guard={w.step === 4 && pr ? merge : dec} label={w.busy ? "Working…" : w.step === 4 ? (pr ? "Approve and merge" : "Open the onboarding PR") : "Continue"} onClick={() => void next()} />
      </div>
    </>
  );
}
