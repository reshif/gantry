/** Plain text controls for dialogs and forms in views (views do not use raw inputs). Wrap them in `Field` so the label and hint are wired. */
import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

export function TextInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`input ${className}`.trim()} />;
}
export function TextArea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={`input ${className}`.trim()} />;
}
