/** Record sections 6 to 11: changes, verification, merge and release, approvals, after release, full timeline. */
import { useMemo, useState } from "react";
import { fmt, flowOf, gateDef, gateExplain, gateKindText, routeGates, type Gate } from "@gantry/domain";
import { Icon } from "../../ui/Icon";
import { Btn, Panel, Segmented } from "../../ui/primitives";
import { useOpenTraveler } from "../../shell/useTraveler";
import { GateDiamond, classOf, roleName } from "../projects/kit";
import { stName, plural, type RecEvent, toRecEvent, bayLabel } from "../traveler/model";
import { Fold, Kv, None, Prov, useName, when } from "./bits";
import { critStatus, ms, sum, useChangesRead, type RecFile } from "./data";
import type { Ctx } from "./sections";

const STATUS: Record<string, [string, string]> = { added: ["A", "Added"], modified: ["M", "Modified"], deleted: ["D", "Deleted"], renamed: ["R", "Renamed"] };
const shortSha = (s: string) => s.slice(0, 7);

interface TreeNode {
  files: RecFile[];
  dirs: Record<string, TreeNode>;
}
function buildTree(files: RecFile[]): TreeNode {
  const root: TreeNode = { files: [], dirs: {} };
  for (const f of files) {
    const parts = f.path.split("/");
    let n = root;
    for (const p of parts.slice(0, -1)) n = n.dirs[p] ??= { files: [], dirs: {} };
    n.files.push(f);
  }
  return root;
}
const allFiles = (n: TreeNode): RecFile[] => [...n.files, ...Object.values(n.dirs).flatMap(allFiles)];
function compress(name: string, node: TreeNode): { name: string; node: TreeNode } {
  let keys = Object.keys(node.dirs);
  while (!node.files.length && keys.length === 1) {
    name = `${name}/${keys[0]}`;
    node = node.dirs[keys[0]!]!;
    keys = Object.keys(node.dirs);
  }
  return { name, node };
}

function FileRow({ f, c, k }: { f: RecFile; c: Ctx; k: string }) {
  const x = STATUS[f.status] ?? ["?", f.status];
  const step = (c.wo.plan || []).find((p) => p.id === f.step);
  return (
    <li className={`rec-file${f.protected ? " is-protected" : ""}`}>
      <div className="rec-file-row">
        <span className={`rec-fst rec-fst-${f.status}`} title={x[1]} aria-label={x[1]}>
          {x[0]}
        </span>
        <span className="rec-file-name mono" title={f.path}>
          {f.path.split("/").pop()}
          {f.from ? <span className="muted">{` ← ${f.from.split("/").pop()}`}</span> : null}
        </span>
        <span className="rec-pm mono">
          <span className="rec-plus">{`+${f.plus}`}</span> <span className="rec-minus">{`−${f.minus}`}</span>
        </span>
        {f.step ? (
          <span className="chip mono" title={step ? `${step.id} ${step.text}` : ""}>
            {f.step}
          </span>
        ) : null}
        {(f.ac ?? []).map((a) => (
          <span key={a} className="chip mono rec-ac-chip" title={c.rec.criteria.find((x) => x.id === a)?.text || a}>
            {a}
          </span>
        ))}
        {f.protected ? (
          <span className="rec-prot" title="Matches a protected path for this repo; needs the extra approval">
            <Icon name="lock" />
            protected
          </span>
        ) : null}
        {f.state ? <span className={`rec-fstate rec-fstate-${f.state}`}>{f.state}</span> : null}
      </div>
      {step ? <div className="rec-file-why small muted">{`${step.id} ${step.text} · serves ${(f.ac ?? []).join(", ")}`}</div> : null}
      {(f.preview ?? []).length ? (
        <Fold k={`${k}diff-${c.wo.id}-${f.path}`} summary={<span className="small">Diff preview</span>}>
          <pre className="rec-diff">
            {(f.preview ?? []).map((l, i) => (
              <span key={i} className={`rec-dl rec-dl-${l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx"}`}>{`${l.t === " " ? "  " : `${l.t} `}${l.s}\n`}</span>
            ))}
          </pre>
        </Fold>
      ) : null}
    </li>
  );
}
function Dir({ name, node, c, k }: { name: string; node: TreeNode; c: Ctx; k: string }) {
  const t = compress(name, node);
  const fs = allFiles(t.node);
  return (
    <li className="rec-dir">
      <div className="rec-dir-row">
        <Icon name="project" />
        <span className="mono">{`${t.name}/`}</span>
        <span className="rec-pm mono small">
          <span className="rec-plus">{`+${sum(fs, "plus")}`}</span> <span className="rec-minus">{`−${sum(fs, "minus")}`}</span>
        </span>
      </div>
      <ul className="rec-tree">
        {Object.keys(t.node.dirs)
          .sort()
          .map((d) => (
            <Dir key={d} name={d} node={t.node.dirs[d]!} c={c} k={k} />
          ))}
        {t.node.files.map((f) => (
          <FileRow key={f.path} f={f} c={c} k={k} />
        ))}
      </ul>
    </li>
  );
}

/* ------------------------------------------------------------------ changes */
export function Changes({ c }: { c: Ctx }) {
  const { wo, rec, pre, compact } = c;
  const name = useName();
  const ch = useChangesRead(wo.id).data;
  const [group, setGroup] = useState<"file" | "commit">("file");
  const files: RecFile[] = useMemo(() => {
    const planFiles = (wo.files ?? []) as RecFile[];
    const real = ch?.files ?? rec.code.files;
    const byPath = new Map(planFiles.map((f) => [f.path, f]));
    const out: RecFile[] = real.map((f) => ({ ...(byPath.get(f.path) ?? {}), ...f }) as RecFile);
    for (const f of planFiles) if (!out.some((x) => x.path === f.path)) out.push(f);
    return out;
  }, [ch, rec.code.files, wo.files]);
  const commits = ch?.commits ?? rec.code.commits.map((x) => ({ sha: x.sha, message: x.message, author: x.author, at: ms(x.at), files: [] as Array<{ path: string; status: string; plus: number; minus: number }> }));
  if (!files.length && !commits.length) return <None text={wo.criteria ? "Nothing planned yet. Plan lists the files before Build." : "No changes yet. Files appear once Build pushes a branch."} />;
  const plus = sum(files, "plus");
  const minus = sum(files, "minus");
  const g = wo.guardrail;
  const T = buildTree(files);
  const committed = commits.length > 0;
  const treeKey = `${pre}`;
  const byFile = (
    <ul className="rec-tree rec-tree-root" aria-label="Files changed">
      {Object.keys(T.dirs)
        .sort()
        .map((d) => (
          <Dir key={d} name={d} node={T.dirs[d]!} c={c} k={treeKey} />
        ))}
      {T.files.map((f) => (
        <FileRow key={f.path} f={f} c={c} k={treeKey} />
      ))}
    </ul>
  );
  const byCommit = committed ? (
    <ol className="rec-commits">
      {commits.map((cm) => (
        <li key={cm.sha} className="rec-commit">
          <div className="rec-commit-head">
            <span className="mono rec-hash">{shortSha(cm.sha)}</span>
            <span className="rec-commit-msg">{cm.message}</span>
          </div>
          <div className="small muted">{`${cm.author ? name(cm.author) : "unknown"} · ${when(cm.at)}`}</div>
          <ul className="rec-tree rec-tree-flat">
            {(cm.files ?? []).map((p) => {
              const f = files.find((x) => x.path === p.path);
              return f ? <FileRow key={p.path} f={f} c={c} k={`${pre}c${cm.sha}-`} /> : <li key={p.path} className="mono small">{p.path}</li>;
            })}
          </ul>
        </li>
      ))}
    </ol>
  ) : (
    <None text="No commits yet. Files below are planned; Build commits them." />
  );
  const guard = (
    <>
      {g ? (
        <div className={`rec-guard${g.over ? " is-over" : ""}`}>
          <div className="small">
            <strong>Change size </strong>
            <span className="mono">{`${g.size} of ${g.maxDiff} lines`}</span>
            {g.over ? (
              <span className="chip chip-block">
                <Icon name="alert" />
                over the guardrail
              </span>
            ) : (
              <span className="muted"> within the Builder&apos;s guardrail</span>
            )}
          </div>
          <div className="rec-guard-bar">
            <GuardBar value={g.size} max={g.maxDiff} />
          </div>
          {g.protectedTouched.length ? (
            <div className="small rec-prot-line">
              <Icon name="lock" /> Protected paths touched: <span className="mono">{g.protectedTouched.join(", ")}</span>
            </div>
          ) : (
            <div className="small muted">No protected paths touched.</div>
          )}
        </div>
      ) : null}
    </>
  );
  const group_ui = (
    <>
      {committed ? <Segmented name={`${pre}group`} label="Group changes" items={[{ id: "file", label: "By file" }, { id: "commit", label: "By commit" }]} value={group} onChange={(v) => setGroup(v as "file" | "commit")} /> : null}
      {group === "commit" && committed ? byCommit : byFile}
      {ch && ch.patches.length ? <p className="small muted">{`${plural(ch.patches.length, "patch", "patches")} stored by content hash (${ch.patches.map((p) => p.ref.slice(0, 15)).join(", ")}).`}</p> : null}
    </>
  );
  if (c.page) {
    const steps = wo.plan || [];
    return (
      <div className="dz-chg">
        <Panel>
          <div className="dz-counts">
            <div><b>{files.length}</b><span>files</span></div>
            <div><b className="num-ok">{`+${plus}`}</b><span>added</span></div>
            <div><b className="num-bad">{`−${minus}`}</b><span>removed</span></div>
            <div><b>{commits.length}</b><span>commits</span></div>
          </div>
          <div className="dz-prov"><Prov kind="system" text={committed ? "Counts from the repository" : "Planned by the Planner agent, not yet in the repository"} /></div>
          {guard}
        </Panel>
        {steps.length ? (
          <Panel title="Plan" tools={<span className="muted small">{plural(steps.length, "step")}</span>}>
            <ol className="dz-plan">
              {steps.map((st) => (
                <li key={st.id}>
                  <b>{st.text}</b>
                  <div className="muted small mono">{st.files.join(", ")}</div>
                  <div className="dz-acs">{st.ac.map((x) => <span key={x} className="chip mono">{x}</span>)}</div>
                </li>
              ))}
            </ol>
          </Panel>
        ) : null}
        <div className="dz-chgbar">
          {committed ? <Segmented name={`${pre}group`} label="Group changes" items={[{ id: "file", label: "By file" }, { id: "commit", label: "By commit" }]} value={group} onChange={(v) => setGroup(v as "file" | "commit")} /> : null}
          <span className="muted small">Open a file to preview its diff.</span>
        </div>
        <Panel flush>{group === "commit" && committed ? <div className="dz-treebox">{byCommit}</div> : <div className="dz-treebox">{byFile}</div>}</Panel>
        {ch && ch.patches.length ? <p className="small muted">{`${plural(ch.patches.length, "patch", "patches")} stored by content hash (${ch.patches.map((p) => p.ref.slice(0, 15)).join(", ")}).`}</p> : null}
      </div>
    );
  }
  return (
    <div>
      <div className="rec-subhead">
        <span className="small">
          <strong className="mono">{plural(files.length, "file")}</strong>
          {" · "}
          <span className="rec-plus mono">{`+${plus}`}</span> <span className="rec-minus mono">{`−${minus}`}</span>
          {` · ${plural(commits.length, "commit")}`}
        </span>
        <Prov kind="system" text={committed ? "From the repository" : "Planned by the Planner agent"} />
      </div>
      {(wo.plan || []).length ? (
        <Fold
          k={`${pre}plan-${wo.id}`}
          defOpen={!compact}
          summary={
            <span className="small">
              <strong>Plan</strong>
              {` · ${plural(wo.plan!.length, "step")}, each tied to an acceptance criterion`}
            </span>
          }
        >
          <ol className="rec-plan">
            {wo.plan!.map((s) => (
              <li key={s.id}>
                <span className="mono chip">{s.id}</span>
                {` ${s.text}`}
                <span className="muted small">{` · ${plural(s.files.length, "file")} · serves ${s.ac.join(", ")}`}</span>
              </li>
            ))}
          </ol>
        </Fold>
      ) : null}
      {guard}
      {group_ui}
    </div>
  );
}
function GuardBar({ value, max }: { value: number; max: number }) {
  const r = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className={`meter${r >= 0.9 ? " is-warn" : ""}`} role="img" aria-label={`Change size against guardrail ${value} of ${max}`}>
      <div className="meter-bar" style={{ width: `${Math.round(r * 100)}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ verification */
export function Verification({ c }: { c: Ctx }) {
  const { wo, rec } = c;
  const cr = rec.criteria;
  if (!cr.length) return <None text="No acceptance criteria yet. They are fixed when the brief is confirmed." />;
  const met = cr.filter((x) => x.status === "met").length;
  const tests = rec.code.tests.passed || rec.code.tests.failed ? rec.code.tests : wo.tests;
  return (
    <div>
      <div className="rec-subhead">
        <span className="small muted">{`${met} of ${cr.length} criteria met`}</span>
        <Prov kind="system" text="Test runs and checks observed from CI" />
      </div>
      <ul className="rec-crit">
        {cr.map((x) => {
          const s = critStatus(x);
          return (
            <li key={x.id} className={`rec-crit-${s.id}`}>
              <div className="rec-crit-head">
                <span className="rec-crit-st">
                  <Icon name={s.icon} />
                  {s.label}
                </span>
                <span className="mono rec-ac">{x.id}</span>
                <span>{x.text}</span>
              </div>
              {x.tests.length ? (
                <ul className="rec-tests mono small">
                  {x.tests.map((t, i) => (
                    <li key={i} className={`is-${t.result}`}>
                      <span className="rec-tres">{t.result === "pass" ? "✓ pass" : "✗ fail"}</span>
                      {` ${t.name}`}
                      <span className="muted">{` ${(t.ms / 1000).toFixed(1)}s`}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="small muted rec-crit-none">No test linked to this criterion yet.</div>
              )}
            </li>
          );
        })}
      </ul>
      {(wo.checks || []).length ? (
        <div className="rec-checks">
          <h4 className="rec-h4">Checks</h4>
          <ul className="rec-list">
            {wo.checks!.map((k, i) => (
              <li key={i} className={`is-${k.status}`}>
                <Icon name={k.status === "passed" ? "check" : k.status === "failed" ? "x" : "st-wait"} />
                <span className="mono">{` ${k.name} `}</span>
                <span className="muted small">{k.status}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {wo.security || wo.coverage || tests.passed || tests.failed ? (
        <dl className="rec-kvs">
          {wo.security ? <Kv k="Security scan">{`${wo.security.findings} finding${wo.security.findings === 1 ? "" : "s"} (${wo.security.severity}). ${wo.security.note}`}</Kv> : null}
          {wo.coverage ? <Kv k="Coverage">{<span className="mono">{`${wo.coverage.before}% → ${wo.coverage.after}% (${wo.coverage.after >= wo.coverage.before ? "+" : ""}${wo.coverage.after - wo.coverage.before})`}</span>}</Kv> : null}
          {tests.passed || tests.failed ? <Kv k="Suite">{<span className="mono">{`${tests.passed} passed · ${tests.failed} failed · ${tests.added} added`}</span>}</Kv> : null}
        </dl>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ merge */
export function Merge({ c }: { c: Ctx }) {
  const { wo, rec, pre, compact } = c;
  const name = useName();
  const prs = rec.code.pullRequests;
  const pr = wo.pr;
  if (!prs.length && !(pr && pr.number)) return <None text={`No pull request yet. Build opens one on gantry/${wo.id.toLowerCase()}.`} />;
  const merged = (wo.files ?? []).filter((f) => f.state === "merged");
  const real = prs[prs.length - 1];
  const rcs = wo.reviewComments ?? [];
  return (
    <div>
      {prs.map((p) => (
        <div key={p.number}>
          <div className="rec-subhead">
            <span className="small">
              <strong className="mono">{`PR #${p.number}`}</strong>
              {` ${p.title || ""}`}
            </span>
            <span className={`chip${p.state === "merged" ? " chip-accent" : ""}`}>{p.draft && p.state === "open" ? "draft" : p.state}</span>
          </div>
          <dl className="rec-kvs">
            <Kv k="Head">{p.headSha ? <span className="mono">{shortSha(p.headSha)}</span> : "–"}</Kv>
            <Kv k="Checks">{pr && pr.number === p.number ? pr.checks : "–"}</Kv>
            <Kv k="Merged">{p.mergedAt ? when(ms(p.mergedAt)) : "not yet"}</Kv>
            <Kv k="Link">{p.url ? <a href={p.url} className="mono small" target="_blank" rel="noreferrer">{p.url}</a> : "–"}</Kv>
            <Kv k="Tag">{pr?.tag ? <span className="mono">{pr.tag}</span> : "–"}</Kv>
            <Kv k="Released">{pr?.releasedAt ? when(pr.releasedAt) : "not yet"}</Kv>
          </dl>
        </div>
      ))}
      {!real && pr ? (
        <dl className="rec-kvs">
          <Kv k="PR">{`#${pr.number} · ${pr.state}`}</Kv>
          <Kv k="Branch">{<span className="mono">{pr.branch}</span>}</Kv>
        </dl>
      ) : null}
      {pr?.body ? (
        <Fold k={`${pre}prbody-${wo.id}`} summary={<span className="small">PR description as generated <Prov kind="agent" text="Written by the Builder agent" /></span>}>
          <pre className="rec-art">{pr.body}</pre>
        </Fold>
      ) : null}
      <h4 className="rec-h4">Review comments</h4>
      {rcs.length ? (
        <ul className="rec-list rec-rc">
          {rcs.map((x, i) => (
            <li key={i}>
              <div>
                <strong>{name(x.by)}</strong>
                <span className="mono small muted">{` ${x.file}:${x.line}`}</span>
                {` ${x.text}`}
              </div>
              <div className={`small ${x.resolved ? "" : "muted"}`}>
                <Icon name={x.resolved ? "check" : "st-wait"} />
                {` ${x.resolved ? x.resolution : "Open"}`}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <None text="No review comments." />
      )}
      <h4 className="rec-h4">What is merged</h4>
      {merged.length ? (
        <p className="small">
          <span className="mono">{`${plural(merged.length, "file")} · +${sum(merged, "plus")} −${sum(merged, "minus")}`}</span>
          <span className="muted">{` · ${merged.map((f) => f.path).join(", ")}`}</span>
        </p>
      ) : (
        <None text={prs.some((p) => p.state === "merged") ? "The pull request is merged." : `Nothing merged yet; ${plural((wo.files ?? []).length || rec.code.files.length, "file")} planned.`} />
      )}
      {pr?.releaseNotes ? (
        <Fold k={`${pre}notes-${wo.id}`} defOpen={!compact} summary={<span className="small">{`Release notes ${pr.tag || ""} `}<Prov kind="agent" text="Written by the Release agent" /></span>}>
          <pre className="rec-art">{pr.releaseNotes}</pre>
        </Fold>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ approvals */
export function ruleText(c: Pick<Ctx, "cat" | "project">, gid: string, name: (id: string) => string): string {
  const gd = gateDef(c.cat, gid);
  const fg = flowOf(c.cat, c.project).gates.find((x) => x.id === gid);
  const mode = fg ? fg.mode : gd?.kind;
  if (mode === "auto") return `Automatic checks${gd?.purpose ? `: ${String(gd.purpose).replace(/\.+$/, "")}` : ""}`;
  const r = c.project.approvers[gid];
  if (!r) return gid === "G0G1" ? "The submitter or a permitted confirmer confirms the brief" : "No approver rule";
  const who = (r.roles || []).map((x) => roleName(c.cat, x)).concat((r.people || []).map(name));
  const parts = [`${r.required || 1} of ${who.join(" or ") || "the project approvers"}`];
  if (mode === "mixed") parts.unshift("Checks, then");
  if (r.sod) parts.push("the author cannot approve");
  (r.conditions || []).forEach((x) => parts.push(x.text));
  if (r.escalateH) parts.push(`escalates after ${r.escalateH}h${r.fallback ? ` to ${name(r.fallback)}` : ""}`);
  return parts.join("; ");
}

export function Approvals({ c }: { c: Ctx }) {
  const { wo, rec, cat, project, pre } = c;
  const name = useName();
  const order = flowOf(cat, project).gates.map((g) => g.id);
  const ids = routeGates(cat, project, wo.cls).slice();
  for (const g of Object.keys(wo.gates || {})) if (!ids.includes(g)) ids.push(g);
  for (const g of rec.gates) if (!ids.includes(g.gate)) ids.push(g.gate);
  ids.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (!ids.length) return <None text="This route has no gates." />;
  return (
    <div>
      <div className="rec-subhead">
        <span className="small muted">{`${plural(ids.length, "gate")} on this route`}</span>
        <Prov kind="system" text="Gate decisions recorded by Gantry" />
      </div>
      <ol className="rec-gates">
        {ids.map((gid) => {
          const g = wo.gates[gid] ?? { status: "pending", approvals: [], rejections: [], checks: [] };
          const gd = gateDef(cat, gid) ?? { label: gid, name: "", custom: false };
          const insts = rec.gates.filter((x) => x.gate === gid);
          const inst = insts[insts.length - 1];
          const d = g.decision;
          const mode = d?.mode ?? inst?.decision?.detail?.mode ?? null;
          const prog = wo.gateProgress?.[gid];
          return (
            <li key={gid} className={`rec-gate rec-gate-${g.status}${mode ? ` rec-gmode-${mode}` : ""}`}>
              <div className="rec-gate-head">
                <GateDiamond cat={cat} gateId={gid} state={g.status === "waiting" ? "waiting" : (g.status as string) === "failed" || (g.status as string) === "rejected" ? "failing" : g.status === "passed" ? "clear" : "off"} count={1} size="sm" />
                <strong title={"purpose" in gd ? gateExplain(gd as Gate) : undefined}>{gd.name || gd.label}</strong>
                {gd.name ? <span className="mono muted small">{gd.label}</span> : null}
                {"kind" in gd ? <span className="chip">{gateKindText((gd as Gate).kind)}</span> : null}
                {gd.custom ? <span className="chip">custom gate</span> : null}
                <span className="chip rec-gst">{g.status}</span>
                {mode ? (
                  <span className={`chip rec-mode rec-mode-${mode}`}>
                    <Icon name={mode === "trust" ? "trust" : mode === "auto" ? "refresh" : "human"} />
                    {mode === "trust" ? `trust ${d?.trust != null ? `L${d.trust}` : ""}` : mode === "auto" ? "automatic" : "person"}
                  </span>
                ) : null}
                {insts.length > 1 ? <span className="chip">{`${insts.length} rounds`}</span> : null}
              </div>
              <div className="small">
                <span className="muted">Rule in force: </span>
                {`${ruleText(c, gid, name)}.`}
              </div>
              {d ? (
                <div className="small">
                  {d.mode === "trust" ? `Passed under trust${d.trust != null ? ` L${d.trust}` : ""}${d.reason ? `. ${d.reason}` : ""}` : d.mode === "auto" ? `Automatic: checks passed${d.trust != null ? ` (trust in force L${d.trust})` : ""}` : `Approved by ${name(d.by)}${d.via && d.via !== "web" ? ` via ${d.via}` : ""}${d.trust != null ? `, trust in force L${d.trust}` : ""}`}
                  {d.at ? `, ${when(d.at)}.` : "."}
                </div>
              ) : null}
              {insts.map((i) =>
                i.votes.length > 1 || i.votes.some((v) => v.vote !== "approve") ? (
                  <ul key={i.id} className="rec-list small">
                    {i.votes.map((v, k) => (
                      <li key={k}>
                        <Icon name={v.vote === "approve" ? "check" : "x"} />
                        {` ${v.vote === "approve" ? "Approved" : "Rejected"} by ${name(v.by)} via ${v.via || "web"}, ${when(ms(v.at))}${v.role ? ` (as ${roleName(cat, v.role)})` : ""}${v.comment ? `: ${v.comment}` : ""}`}
                      </li>
                    ))}
                  </ul>
                ) : null,
              )}
              {inst ? (
                <div className="small muted">
                  {`Instance ${inst.id} · pinned to flow v${inst.pinned.flowVersion}, rule v${inst.pinned.ruleVersion ?? "–"}, policy v${inst.pinned.policyVersion ?? "–"}${inst.headSha ? ` · head ${shortSha(inst.headSha)}` : ""}${inst.closedReason ? ` · closed: ${inst.closedReason}` : ""}`}
                </div>
              ) : null}
              {g.status === "waiting" ? (
                <div className="small rec-wait">
                  <Icon name="st-wait" />
                  {` Waiting since ${when(g.waitingSince)}. ${prog ? `${prog.have} of ${prog.need} approvals. ` : ""}${g.trustNote || "A person decides."}${prog && prog.unmet.length ? ` Still needs: ${prog.unmet.map((x) => x.text).join("; ")}.` : ""}`}
                </div>
              ) : null}
              {(g.checks || []).length ? <div className="small muted">{`Checks: ${g.checks.map((x) => `${x.ok ? "✓" : "✗"} ${x.name}`).join(" · ")}`}</div> : null}
            </li>
          );
        })}
      </ol>
      <p className="small">
        <a href="#trust" id={`${pre}to-trust`}>
          Trust ladder for this project
        </a>
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ after release */
export function After({ c }: { c: Ctx }) {
  const { wo, rec, pre } = c;
  const name = useName();
  const open = useOpenTraveler();
  const oc = rec.outcomes;
  const shipped = wo.state === "done" && !wo.split;
  if (!oc.length) return <None text={shipped ? "Watching after release. Nothing observed yet." : "Not released yet. Outcomes are watched after release."} />;
  return (
    <div>
      <div className="rec-subhead">
        <span className="small muted">{`${plural(oc.length, "outcome")} observed`}</span>
        <Prov kind="system" text="Observed after release, or reported by a person" />
      </div>
      <ul className="rec-outcomes">
        {oc.map((o, i) => (
          <li key={i} className={`rec-oc rec-oc-${o.kind}`}>
            <span className="rec-oc-k">
              <Icon name={o.kind === "healthy" ? "st-done" : "alert"} />
              {o.kind + (o.severity ? ` · ${o.severity}` : "")}
            </span>
            <span>
              {o.text}
              {o.by ? <span className="muted small">{` Reported by ${name(o.by)}.`}</span> : null}
            </span>
            <span className="muted small mono">{when(o.at)}</span>
          </li>
        ))}
      </ul>
      {wo.children.length ? (
        <div>
          <h4 className="rec-h4">Child work orders</h4>
          <ul className="rec-list">
            {wo.children.map((id) => (
              <li key={id}>
                <button type="button" className="linkish mono" id={`${pre}child-${id}`} onClick={() => open(id)}>
                  {id}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ timeline */
function eventText(e: RecEvent, c: Ctx, name: (id: string) => string): string {
  const { cat, wo } = c;
  const gate = e.gate ? gateDef(cat, e.gate) : undefined;
  const gname = gate ? `${gate.label} ${gate.name}` : (e.gate ?? "");
  switch (e.type) {
    case "wo.submit": return `Submitted by ${name(e.by)}${e.text ? `: ${e.text}` : ""}`;
    case "wo.enter": return `Entered ${e.station ? `${cat.stations.find((s) => s.id === e.station)?.no ?? ""} ${stName(cat, e.station)}`.trim() : ""}`;
    case "gate.decision": return `${gname} ${e.mode === "auto" ? "passed its automatic checks" : e.mode === "trust" ? "passed under trust" : `approved by ${name(e.by)}`}`;
    case "gate.waiting": return `Waiting at ${gname}`;
    case "trust.auto": return `${gname} passed under trust`;
    case "wo.station.done": return `${stName(cat, e.station)} finished${e.text && e.text !== "done" ? `: ${e.text}` : ""}`;
    case "wo.answer": return `Answered: ${e.text ?? ""}`;
    case "wo.bay": return e.bay ? `Moved to ${bayLabel(cat, e.bay)}${e.text ? `: ${e.text}` : ""}` : "Back on the belt";
    case "wo.state": return `State changed${e.text ? `: ${e.text}` : ""}`;
    case "outcome": return `Post-release outcome recorded by ${name(e.by)}${e.text ? `: ${e.text}` : ""}`;
    case "release": return `Released${e.text ? ` ${e.text}` : wo.pr?.tag ? ` ${wo.pr.tag}` : ""}`;
    case "wo.done": return "Closed and shipped";
    case "kill": return `Killed${e.text ? `: ${e.text}` : ""}`;
    case "restore": return `Restored${e.text ? `: ${e.text}` : ""}`;
    case "halt": return `Andon halt${e.text ? `: ${e.text}` : ""}`;
    case "resume": return "Resumed after halt";
    default: return e.text ? `${e.type}: ${e.text}` : e.type;
  }
}
export { eventText };

export function Timeline({ c }: { c: Ctx }) {
  const { wo, rec, pre, compact } = c;
  const name = useName();
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    const out: Array<{ at: number; kind: "event" | "log"; who: string; text: string; outcome?: string; seq?: number }> = [];
    for (const raw of rec.events) {
      const e = toRecEvent(raw);
      out.push({ at: e.at, kind: "event", who: e.by === "system" ? "Gantry" : name(e.by), text: eventText(e, c, name), outcome: e.outcome, seq: e.seq });
    }
    for (const l of wo.log || []) {
      if (/^Entered |^Submitted from | approved\.$|^Approved \S+ \(/.test(l.text)) continue;
      out.push({ at: l.at, kind: "log", who: name(l.who), text: l.text });
    }
    return out.sort((a, b) => a.at - b.at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.events, wo.log, wo.pr]);
  if (!rows.length) return <None text="No events yet." />;
  const limit = compact ? 12 : 40;
  const shown = all || rows.length <= limit ? rows : rows.slice(rows.length - limit);
  return (
    <div>
      <div className="rec-subhead">
        <span className="small muted">{`${plural(rows.length, "entry", "entries")}: events and the work order log`}</span>
        <Prov kind="system" text="Event log and audit ledger" />
      </div>
      {shown.length < rows.length ? (
        <p className="small">
          <Btn label={`Show all ${rows.length}`} small kind="ghost" id={`${pre}tl-all`} onClick={() => setAll(true)} />
          <span className="muted">{` Showing the latest ${shown.length}.`}</span>
        </p>
      ) : null}
      <ol className="rec-tl">
        {shown.map((r, i) => (
          <li key={`${r.seq ?? "l"}-${i}`} className={`rec-tl-${r.kind}${r.outcome === "denied" ? " is-denied" : ""}`}>
            <span className="mono muted rec-tl-t">{`${fmt.istDate(r.at)} ${fmt.ist(r.at)}`}</span>
            <span className="rec-tl-k mono">{r.kind}</span>
            <span className="rec-tl-who">{r.who}</span>
            <span className="rec-tl-x">{r.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
void classOf;
