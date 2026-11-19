/**
 * Factory Admin override at a gate. The server says so in the decision (`override: true` on a refused approve, with `overrideKind` "halt" or
 * "freeze"); only an admin ever receives it, so nobody else sees these controls. The control then reads "<verb> anyway", says why the gate is
 * held and takes a reason (at least 5 characters) that is sent with the approve and recorded in the audit.
 */
import { Field } from "../../ui/primitives";
import { TextArea } from "../../ui/TextControls";

export const OVERRIDE_MIN = 5;

interface Overridable {
  allowed: boolean;
  override?: boolean | undefined;
  overrideKind?: string | undefined;
}

/** The kind of stop an admin may override here, or null when the decision needs no override (or is not an override at all). */
export function overrideKindOf(d: Overridable | null | undefined): "halt" | "freeze" | null {
  if (!d || d.allowed || !d.override) return null;
  return d.overrideKind === "freeze" ? "freeze" : "halt";
}

/** Why the gate is held, in the admin's words. */
export const overrideWhy = (kind: "halt" | "freeze"): string => (kind === "freeze" ? "A release freeze is on." : "The line is halted.");

/** "Approve anyway" / "Release anyway" (the release gate) / "Confirm anyway" (the brief). */
export function anywayLabel(gate: string): string {
  return gate === "G6" ? "Release anyway" : gate === "G0G1" ? "Confirm anyway" : "Approve anyway";
}

/** The inline reason box: required, with its minimum and the promise that it is audited. */
export function OverrideReason({ id, value, onChange, error, why, min = OVERRIDE_MIN, label, hint = "Recorded in the audit and on the work order." }: { id: string; value: string; onChange: (v: string) => void; error?: string | undefined; why?: string | undefined; min?: number; label?: string; hint?: string }) {
  return (
    <div className="ovr-reason" id={`${id}-wrap`}>
      {why ? <p className="small" id={`${id}-why`}><strong>{why}</strong> Only a Factory Admin can go ahead.</p> : null}
      <Field label={label ?? `Reason (at least ${min} characters)`} htmlFor={id} hint={hint} error={error || undefined}>
        <TextArea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
      </Field>
    </div>
  );
}
