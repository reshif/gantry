/**
 * Plain form controls for views: a text-like <input> (also radio and checkbox) and a <textarea>, styled as the design system's `input`.
 * Views use these (inside a `Field`, which wires the label, hint and error) instead of raw elements. Additive: nothing else changes.
 */
import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input({ mono, className, type, ...rest }, ref) {
  const plain = type === "radio" || type === "checkbox";
  return <input ref={ref} type={type} className={plain ? (className ?? "cb") : `input in${mono ? " mono" : ""}${className ? ` ${className}` : ""}`} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(function TextArea({ mono, className, ...rest }, ref) {
  return <textarea ref={ref} className={`input${mono ? " mono" : ""}${className ? ` ${className}` : ""}`} {...rest} />;
});
