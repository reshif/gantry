/** A number box for forms (USD amounts and the like); a native control kept out of the views so they use only `Field` and primitives. */
import type { ChangeEvent } from "react";

export function NumberInput({ id, value, onChange, step = "0.01", mono = true }: { id?: string; value: string; onChange: (v: string) => void; step?: string; mono?: boolean }) {
  return <input id={id} className={`input${mono ? " mono" : ""}`} type="number" min="0" step={step} value={value} onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)} />;
}
