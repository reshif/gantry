/** A multi-line text control for use inside `Field` (additive primitive: views never write a raw <textarea>). */
import type { TextareaHTMLAttributes } from "react";

export function Textarea({ id, value, onChange, className, ...rest }: { id: string; value: string; onChange: (v: string) => void } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value" | "id">) {
  return <textarea id={id} className={`input${className ? ` ${className}` : ""}`} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />;
}
