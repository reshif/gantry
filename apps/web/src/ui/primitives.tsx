/**
 * The h()-based primitives of legacy ui.js as React components. Same DOM, same classes.
 * "decision" is a can() result: { allowed, reason, needs }. A forbidden control stays visible and
 * focusable, carries aria-disabled and data-reason, and shows the reason in the tooltip.
 */
import { Children, cloneElement, forwardRef, isValidElement, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { WO_STATES } from "@gantry/domain";
import { Icon } from "./Icon";
import { tip } from "./Tip";
import { useActors } from "./actors";
import { useUI } from "./overlay-context";

export interface Decision {
  allowed: boolean;
  reason: string;
  needs?: string | undefined;
}

/** Text shown for a locked control: "<needs>. <reason>". */
export const reasonText = (d: Decision): string => (d.needs ? `${d.needs}. ` : "") + d.reason;

/** aria/class/data attributes for a guarded element. */
export function guardProps(d: Decision | null | undefined): { "aria-disabled"?: "true"; "data-reason"?: string; locked: boolean } {
  if (d && !d.allowed) return { "aria-disabled": "true", "data-reason": reasonText(d), locked: true };
  return { locked: false };
}

/* ---------- buttons ---------- */

export interface BtnProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children"> {
  label?: ReactNode;
  kind?: "primary" | "danger" | "ghost" | "quiet" | (string & {});
  small?: boolean;
  cls?: string;
  icon?: string;
  aria?: string;
  disabledReason?: string | null | undefined;
  guard?: Decision | null | undefined;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children?: ReactNode;
}

export function Btn({ label, kind, small, cls, icon, aria, disabledReason, guard, onClick, type = "button", children, ...rest }: BtnProps) {
  const g = guardProps(guard);
  const reason = disabledReason || g["data-reason"];
  const locked = !!disabledReason || g.locked;
  const className = `btn ${kind ? `btn-${kind} ${kind}` : ""}${small ? " btn-sm sm" : ""}${cls ? ` ${cls}` : ""}${locked ? " is-locked" : ""}`;
  const showWhy = locked && !!reason;
  return (
    <button
      {...rest}
      type={type}
      className={className}
      aria-label={aria}
      // why it is locked, read by screen readers with the control (the tooltip shows it on hover, focus and tap)
      aria-description={locked && reason ? reason : undefined}
      // the shared tooltip node (ui/Tip) carries this control's reason while it has focus
      aria-describedby={showWhy ? "tip" : rest["aria-describedby"]}
      aria-disabled={locked ? "true" : undefined}
      data-reason={reason || undefined}
      onClick={(e) => {
        if (locked) {
          e.preventDefault();
          e.stopPropagation();
          tip.show(e.currentTarget);
          return;
        }
        onClick?.(e);
      }}
    >
      {icon ? <Icon name={icon} /> : null}
      {label ? <span>{label}</span> : null}
      {children}
    </button>
  );
}

export function IconBtn({ icon, label, className = "", onClick, ...rest }: { icon: string; label: string; className?: string; onClick?: () => void } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  return (
    <button type="button" {...rest} className={`icon-btn ${className}`} aria-label={label} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

/* ---------- form controls ---------- */

/** Switch (checkbox with role=switch). A forbidden decision locks it and shows the reason on click. */
export function Toggle({ id, checked, onChange, decision, label }: { id: string; checked: boolean; onChange?: (v: boolean) => void; decision?: Decision | null; label?: string }) {
  const g = guardProps(decision);
  return (
    <span className={`switch${g.locked ? " is-locked" : ""}`}>
      <input
        aria-description={g["data-reason"]}
        type="checkbox"
        role="switch"
        id={id}
        className={`switch-input${g.locked ? " is-locked" : ""}`}
        checked={checked}
        aria-label={label}
        aria-disabled={g["aria-disabled"]}
        data-reason={g["data-reason"]}
        onClick={(e) => {
          if (g.locked) {
            e.preventDefault();
            tip.show(e.currentTarget);
          }
        }}
        onChange={(e) => {
          if (!g.locked) onChange?.(e.target.checked);
        }}
      />
      <span className="switch-track" aria-hidden="true" />
    </span>
  );
}

export interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

export function Select({ id, options, value, onChange, ...rest }: { id: string; options: Array<string | Option>; value: string | null | undefined; onChange?: (v: string) => void } & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value" | "id">) {
  return (
    <select {...rest} id={id} className="input in" value={value ?? ""} onChange={(e) => onChange?.(e.target.value)}>
      {options.map((o) => {
        const opt = typeof o === "string" ? { value: o, label: o } : o;
        return (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        );
      })}
    </select>
  );
}

/**
 * Label + control + description + error, wired for assistive tech.
 *  - When the child is one element (an input, textarea, Select ...) Field gives it an id (its own, or one it generates),
 *    `aria-describedby` pointing at the description and error, `aria-invalid` while there is an error, and `aria-required`.
 *  - With several children, pass the control's id as `htmlFor`; the description and error then describe the whole group.
 * `hint` and `description` are the same slot. The error is spoken when it appears (role="alert").
 */
export function Field({ label, htmlFor, hint, description, error, required, children }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; description?: ReactNode; error?: ReactNode; required?: boolean; children: ReactNode }) {
  const gen = useFieldId("fld");
  const desc = description ?? hint;
  const el = isValidElement(children) ? (children as ReactElement<Record<string, unknown>>) : null;
  // wire the child only when it is a native control, or a component that names its own id (so unknown props never leak into custom controls)
  const only = el && (typeof el.type === "string" ? ["input", "textarea", "select"].includes(el.type) : typeof el.props.id === "string") ? el : null;
  const ownId = typeof only?.props.id === "string" ? (only.props.id as string) : undefined;
  const controlId = ownId ?? htmlFor ?? gen;
  const descId = desc ? `desc-${controlId}` : undefined;
  const errId = error ? `err-${controlId}` : undefined;
  const describedBy = [only?.props["aria-describedby"] as string | undefined, descId, errId].filter(Boolean).join(" ") || undefined;
  const control = only
    ? cloneElement(only, {
        id: controlId,
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(error ? { "aria-invalid": true } : {}),
        ...(required ? { "aria-required": true } : {}),
      })
    : children;
  const groupProps = !only && (descId || errId) ? { role: "group", "aria-labelledby": `lbl-${controlId}`, "aria-describedby": [descId, errId].filter(Boolean).join(" ") } : {};
  return (
    <div className={`field${error ? " invalid" : ""}`} {...groupProps}>
      <label className="field-label" id={`lbl-${controlId}`} htmlFor={controlId}>
        {label}
        {required ? <span className="field-req" aria-hidden="true"> *</span> : null}
      </label>
      {control}
      {desc ? <div className="field-hint hint" id={descId}>{desc}</div> : null}
      {error ? <div className="field-error err" id={errId} role="alert">{error}</div> : null}
    </div>
  );
}

/** The one text input (prototype `.in`). Additive primitive: views use it inside a Field instead of a raw <input>. */
export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className = "", ...rest }, ref) {
  return <input {...rest} ref={ref} className={`input in${className ? ` ${className}` : ""}`} />;
});

/** Moves focus to the first control inside `root` marked aria-invalid (call after a failed submit). Returns whether one was found. */
export function focusFirstInvalid(root: ParentNode): boolean {
  const el = root.querySelector<HTMLElement>('[aria-invalid="true"]');
  el?.focus();
  return !!el;
}

export function LockNote({ decision, what }: { decision: Decision | null | undefined; what?: string }) {
  if (!decision || decision.allowed) return null;
  return (
    <div className="lock-note" role="note">
      <Icon name="lock" />
      <span>
        {(what ? `Read-only for you: ${what.charAt(0).toLowerCase()}${what.slice(1)}. ` : "") + (decision.needs ? `${decision.needs}. ` : "") + decision.reason}
      </span>
    </div>
  );
}

export interface TabItem {
  id: string;
  label: ReactNode;
  count?: number | string | null;
}

export function Tabs({ items, active, onChange, idPrefix = "tab" }: { items: TabItem[]; active: string; onChange: (id: string) => void; idPrefix?: string }) {
  const bar = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState("");
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const measure = () => {
      const start = el.scrollLeft > 2;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setMore([start ? "start" : "", end ? "end" : ""].filter(Boolean).join(" "));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [items.length]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const tabs = Array.from(bar.current?.querySelectorAll<HTMLButtonElement>(".tab") ?? []);
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    n?.focus();
    n?.click();
  };
  return (
    <div className={`tabs-w${more.includes("start") ? " ov-l" : ""}${more.includes("end") ? " ov-r" : ""}`}>
    <div className="tabs" role="tablist" data-more={more || undefined} ref={bar} onKeyDown={onKey}>
      {items.map((it) => (
        <button key={it.id} type="button" role="tab" id={`${idPrefix}-${it.id}`} className={`tab${it.id === active ? " is-active" : ""}`} aria-selected={it.id === active ? "true" : "false"} onClick={() => onChange(it.id)}>
          {it.label}
          {it.count != null ? <span className="tab-count badge">{String(it.count)}</span> : null}
        </button>
      ))}
    </div>
    </div>
  );
}

/** Radio group styled as buttons. */
export function Segmented({ name, items, value, onChange, label }: { name: string; items: Array<{ id: string; label: string; icon?: string; count?: ReactNode }>; value: string; onChange: (id: string) => void; label?: string }) {
  return (
    <div className="seg seg-radio" role="radiogroup" aria-label={label || name}>
      {items.map((it) => {
        const id = `${name}-${it.id}`;
        return [
          <input key={`i-${it.id}`} type="radio" name={name} id={id} value={it.id} checked={it.id === value} className="seg-input" onChange={() => onChange(it.id)} />,
          <label key={`l-${it.id}`} htmlFor={id} className="seg-label">
            {it.icon ? <Icon name={it.icon} /> : null}
            <span>{it.label}</span>
            {it.count != null ? <span className="badge tab-count">{it.count}</span> : null}
          </label>,
        ];
      })}
    </div>
  );
}

/* ---------- badges, chips, actors ---------- */

const STATE_FALLBACK = { label: "", glyph: "dots" };

export function StateChip({ state, compact }: { state: string; compact?: boolean }) {
  const def = (WO_STATES as Record<string, { label: string; glyph: string }>)[state] ?? { ...STATE_FALLBACK, label: state };
  return (
    <span className={`state state-${state}${compact ? " compact" : ""}`}>
      <Icon name={def.glyph} />
      {compact ? null : <span>{def.label}</span>}
    </span>
  );
}

export const Chip = ({ text, cls = "" }: { text: ReactNode; cls?: string }) => <span className={`chip ${cls}`}>{text}</span>;
export const Mono = ({ children, cls = "" }: { children: ReactNode; cls?: string }) => <span className={`mono ${cls}`}>{children}</span>;

export function Avatar({ id, size }: { id: string | null | undefined; size?: string }) {
  const actor = useActors()(id);
  return (
    <span className={`av ${actor.kind === "agent" ? "av-agent" : "av-person"}${size ? ` av-${size}` : ""}`} title={actor.name} aria-hidden="true">
      {actor.initials}
    </span>
  );
}

export function Who({ id }: { id: string | null | undefined }) {
  const actor = useActors()(id);
  return (
    <span className="who">
      <Avatar id={id} size="sm" />
      <span>{actor.name.replace(" (agent)", "")}</span>
    </span>
  );
}

/* ---------- layout pieces ---------- */

/** The one empty state: a title, a line of text, an optional action. `icon` and `tone` are for the shared
 *  not-visible and failed states (ui/async); a screen's own empty state is usually quiet, without them. */
export function Empty({ title, text, action, id, icon, tone }: { title: ReactNode; text?: ReactNode; action?: ReactNode; id?: string; icon?: string; tone?: "block" }) {
  return (
    <div className={`empty${icon ? " empty-state" : ""}${tone ? ` empty-${tone}` : ""}`} id={id}>
      <div className="ei empty-icon" aria-hidden="true">
        <Icon name={icon ?? "inbox"} />
      </div>
      <h3 className="empty-title">{title}</h3>
      {text != null ? <p>{text}</p> : null}
      {action ?? null}
    </div>
  );
}

export function ViewHead({ kicker, title, status, sub, meta, actions }: { kicker?: ReactNode; title: ReactNode; status?: ReactNode; sub?: ReactNode; meta?: Array<[ReactNode, ReactNode]>; actions?: ReactNode }) {
  return (
    <header className="vhead ph">
      <div className="vhead-main">
        {kicker ? <div className="kicker eyebrow">{kicker}</div> : null}
        {status ? <div className="vtitle-row"><h1 className="vtitle">{title}</h1>{status}</div> : <h1 className="vtitle">{title}</h1>}
        {sub ? <p className="vsub sub">{sub}</p> : null}
      </div>
      {meta ? (
        <dl className="titleblock">
          {meta.map((m, i) => (
            <div key={i}>
              <dt>{m[0]}</dt>
              <dd>{m[1]}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {actions ? <div className="vhead-actions acts">{actions}</div> : null}
    </header>
  );
}

/** One stat tile: a quiet label, a big value, an optional note. Put them in <StatRow>. `value` may be the result of qState(). */
export function Stat({ label, value, sub, tone, icon, id, action }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "wait" | "block" | "done"; icon?: string; id?: string; action?: ReactNode }) {
  return (
    <div className={`stat-tile stat${tone ? ` stat-${tone} ${tone === "wait" ? "warn" : tone === "block" ? "bad" : "ok"}` : ""}`} id={id}>
      <div className="stat-lbl label">
        <span>{label}</span>
        {icon ? <Icon name={icon} /> : null}
      </div>
      <div className="stat-val v">{value}</div>
      {sub ? <div className="stat-sub d">{sub}</div> : null}
      {action ? <div className="stat-act">{action}</div> : null}
    </div>
  );
}

/** A single row of equal stat tiles under the page header (two columns on a phone). */
export function StatRow({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <div className="stat-row stats" id={id} style={{ "--n": Children.toArray(children).length || 1 } as React.CSSProperties}>
      {children}
    </div>
  );
}

/** The one filter toolbar: filters and search on the left (children), the result count and secondary actions on the right. */
export function FilterBar({ children, count, actions, label = "Filters" }: { children?: ReactNode; count?: ReactNode; actions?: ReactNode; label?: string }) {
  // prototype grid: search, then one column per select (--fn), then the meta cell
  const n = Math.max(0, Children.toArray(children).length - 1);
  return (
    <div className="filterbar fb" role="search" aria-label={label} style={{ "--fn": n } as React.CSSProperties}>
      {children}
      {count != null || actions ? (
        <div className="meta">
          {count != null ? <span className="filterbar-count" role="status">{count}</span> : null}
          {actions ? <div className="filterbar-end">{actions}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** A search box for a FilterBar: icon inside, labelled for screen readers. */
export function SearchBox({ id, value, onChange, placeholder = "Search", label }: { id?: string; value: string; onChange: (v: string) => void; placeholder?: string; label?: string }) {
  return (
    <span className="searchbox search">
      <Icon name="search" />
      <input id={id} className="input in" type="search" value={value} placeholder={placeholder} aria-label={label ?? placeholder} onChange={(e) => onChange(e.target.value)} />
    </span>
  );
}

export function Panel({ title, children, cls = "", tools, flush }: { title?: ReactNode; children: ReactNode; cls?: string; tools?: ReactNode; flush?: boolean }) {
  return (
    <section className={`panel ${cls}`} aria-label={typeof title === "string" ? title : undefined}>
      {title ? (
        <div className="panel-head">
          <h2 className="panel-title">{title}</h2>
          {tools ? <div className="panel-tools">{tools}</div> : null}
        </div>
      ) : null}
      <div className={`panel-body${flush ? " flush" : ""}`}>{children}</div>
    </section>
  );
}

/** Horizontal meter (value vs budget). */
export function Meter({ value, max, label, warnAt = 0.85 }: { value: number; max: number; label?: string; warnAt?: number }) {
  const pct = max ? Math.min(1, value / max) : 0;
  return (
    <div className={`meter${pct >= warnAt ? " meter-warn" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.round(value)} aria-label={label || "Usage"}>
      <span className="meter-fill" style={{ width: `${(pct * 100).toFixed(1)}%` }} />
    </div>
  );
}

/** A multi-line text input in the standard field look. Additive primitive: views use it with Field instead of a raw <textarea>. */
export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className = "", ...rest }, ref) => <textarea ref={ref} className={`input ${className}`.trim()} {...rest} />);
Textarea.displayName = "Textarea";

/** Table in the standard scroll wrapper. */
export function Table({ compact, children, className = "" }: { compact?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className="table-scroll">
      <table className={`table${compact ? " table-compact" : ""} ${className}`.trim()}>{children}</table>
    </div>
  );
}

/** Copy text to the clipboard with a toast either way (legacy G.copy). */
export function useCopy(): (text: string) => void {
  const ui = useUI();
  return (text) => {
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(
          () => ui.toast(`Copied ${text}`),
          () => ui.toast("Copy is not available in this frame", "warn"),
        );
      } else ui.toast("Copy is not available in this frame", "warn");
    } catch {
      ui.toast("Copy is not available in this frame", "warn");
    }
  };
}

/** Stable unique id for form controls inside a component. */
export const useFieldId = (prefix = "f"): string => `${prefix}-${useId().replace(/:/g, "")}`;

/* ---------- status (docs/ui/design-system.md §2) ---------- */

export type Tone = "run" | "wait" | "block" | "fail" | "done" | "accent" | "neutral";
const CHIP_TONE: Record<Tone, string> = { run: "info", wait: "warn", block: "bad", fail: "bad", done: "ok", accent: "agent", neutral: "idle" };
const TONE_GLYPH: Record<Tone, string> = { run: "st-run", wait: "st-wait", block: "st-block", fail: "st-fail", done: "st-done", accent: "st-park", neutral: "st-park" };

/** The one status badge: a glyph and a word on a soft tone. Colour never carries meaning alone. */
export function Status({ tone, icon, children, title, id }: { tone: Tone; icon?: string | null; children: ReactNode; title?: string; id?: string }) {
  const glyph = icon === null ? null : (icon ?? TONE_GLYPH[tone]);
  return (
    <span className={`status tone-${tone} chip ${CHIP_TONE[tone]}${glyph ? "" : " plain"}`} title={title} id={id}>
      <span>{children}</span>
    </span>
  );
}
