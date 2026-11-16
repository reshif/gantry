/**
 * Pipeline pieces for one work order's journey, in the look of docs/ui/design-system.md: a compact row of station chips
 * (PipelineRow) and the larger rail for a work order page (PipelineRail). Presentation only: callers pass what the API
 * says about each station and gate; nothing here decides what a station is or whether a gate is open.
 */
import type { ReactNode } from "react";
import { Icon } from "./Icon";

export type StepState = "passed" | "failed" | "running" | "warn" | "waiting" | "skip";
export type GateState = "passed" | "override" | "wait" | "todo";

const STEP_GLYPH: Record<StepState, string | null> = { passed: "check", failed: "x", running: "play", warn: "alert", waiting: null, skip: null };
const STATE_WORD: Record<StepState, string> = { passed: "passed", failed: "failed", running: "running", warn: "needs attention", waiting: "waiting", skip: "skipped" };

/** One station as a chip: a state glyph and its name. Pass `href` or `onClick` to make it a link or button. */
export function StationChip({ name, state, href, onClick, id }: { name: ReactNode; state: StepState; href?: string; onClick?: () => void; id?: string }) {
  const glyph = STEP_GLYPH[state];
  const inner = (
    <>
      <span className="step-ico" aria-hidden="true">{glyph ? <Icon name={glyph} /> : null}</span>
      <span>{name}</span>
      <span className="sr">{`, ${STATE_WORD[state]}`}</span>
    </>
  );
  const cls = `step step-${state}`;
  if (href) return <a className={cls} href={href} id={id}>{inner}</a>;
  if (onClick) return <button type="button" className={cls} onClick={onClick} id={id}>{inner}</button>;
  return <span className={cls} id={id}>{inner}</span>;
}

/** A gate between two stations: a small diamond. The label is for screen readers and the tooltip. */
export function GateMark({ state, label }: { state: GateState; label: string }) {
  return <span className={`pgate pgate-${state}`} role="img" aria-label={label} data-tip={label} />;
}

export interface PipelineStep {
  key: string;
  name: ReactNode;
  state: StepState;
  href?: string;
  /** The gate after this station, if there is one. */
  gate?: { state: GateState; label: string };
}

/** Stations left to right with gates between them; scrolls sideways when it does not fit. */
export function PipelineRow({ steps, label = "Pipeline", id }: { steps: PipelineStep[]; label?: string; id?: string }) {
  return (
    <div className="pipe-wrap" id={id}>
      <ol className="pipe plain-list" aria-label={label}>
        {steps.map((s, i) => (
          <li key={s.key}>
            <StationChip name={s.name} state={s.state} {...(s.href ? { href: s.href } : {})} />
            {s.gate ? <><span className="step-link" aria-hidden="true" /><GateMark state={s.gate.state} label={s.gate.label} /><span className="step-link" aria-hidden="true" /></> : i < steps.length - 1 ? <span className="step-link" aria-hidden="true" /> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

export interface RailStep {
  key: string;
  name: ReactNode;
  tone: "done" | "run" | "warn" | "bad" | "todo";
  /** The gate after this station. */
  gate?: { tone: "done" | "warn" | "todo"; label: string };
}

const RAIL_GLYPH: Record<RailStep["tone"], string | null> = { done: "check", run: "play", warn: "alert", bad: "x", todo: null };

/** The large rail for a work order page: numbered circles on a line, a diamond for each gate. Done stretches are solid, the rest dashed. */
export function PipelineRail({ steps, label = "Progress", id }: { steps: RailStep[]; label?: string; id?: string }) {
  return (
    <ol className="prail plain-list" aria-label={label} id={id}>
      {steps.map((s, i) => {
        const g = RAIL_GLYPH[s.tone];
        const next = steps[i + 1];
        return (
          <li key={s.key}>
            <span className="prail-st">
              <span className={`prail-circ${s.tone === "warn" ? " is-warn" : s.tone === "bad" ? " is-bad" : s.tone === "run" ? " is-run" : s.tone === "todo" ? " is-todo" : ""}`} aria-hidden="true">{g ? <Icon name={g} /> : null}</span>
              <span>{s.name}</span>
              <span className="sr">{`, ${s.tone === "done" ? "done" : s.tone === "run" ? "running" : s.tone === "warn" ? "needs attention" : s.tone === "bad" ? "failed" : "not started"}`}</span>
            </span>
            {next ? (
              <>
                <span className={`prail-ln${s.tone === "todo" ? " is-todo" : ""}`} aria-hidden="true" />
                {s.gate ? <><span className={`prail-gt${s.gate.tone === "warn" ? " is-warn" : s.gate.tone === "todo" ? " is-todo" : ""}`} role="img" aria-label={s.gate.label} data-tip={s.gate.label} /><span className={`prail-ln${s.gate.tone === "todo" ? " is-todo" : ""}`} aria-hidden="true" /></> : null}
              </>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
