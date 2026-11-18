/** The prototype's menu language (.mi rows, .mh headers) inside an anchored popover: role=menu, ArrowUp/Down wrap, check icon on the chosen row. */
import type { KeyboardEvent, ReactNode } from "react";
import { CrIcon } from "../ui/cr";

export function CrMenu({ children, onKey }: { children: ReactNode; onKey?: (e: KeyboardEvent<HTMLDivElement>) => void }) {
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    onKey?.(e);
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(".mi"));
    if (!rows.length) return;
    const i = rows.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    rows[(i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
  };
  // roving focus for the rows inside: the keys belong to the menu, the rows are the interactive elements
  // eslint-disable-next-line jsx-a11y/no-static-element-interactions
  return <div className="crm" onKeyDown={move}>{children}</div>;
}

export function MenuHead({ children }: { children: ReactNode }) {
  return <div className="mh label">{children}</div>;
}

export function MenuRow({ icon, lead, label, tag, checked, radio, onClick, href }: { icon?: string; lead?: ReactNode; label: ReactNode; tag?: ReactNode; checked?: boolean; radio?: boolean; onClick?: () => void; href?: string }) {
  const body = (
    <>
      {lead ?? (icon ? <CrIcon name={icon} /> : null)}
      <span style={{ flex: 1 }}>{label}</span>
      {tag ? <span className="tag">{tag}</span> : null}
      {checked ? <CrIcon name="check" /> : null}
    </>
  );
  if (href) return <a className="mi" role="menuitem" href={href} onClick={onClick}>{body}</a>;
  return (
    <button type="button" className="mi" role={radio ? "menuitemradio" : "menuitem"} {...(radio ? { "aria-checked": !!checked } : {})} onClick={onClick}>
      {body}
    </button>
  );
}

export const MenuDivider = () => <div className="divider" role="separator" />;
