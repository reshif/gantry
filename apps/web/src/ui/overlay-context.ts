import { createContext, useContext, type ReactNode } from "react";
import type { Decision } from "./primitives";

export type ToastKind = "info" | "ok" | "warn" | "error";

export interface ToastAction {
  label: string;
  id?: string;
  onClick: () => void;
}

export interface DialogAction {
  label: string;
  kind?: string;
  icon?: string;
  id?: string;
  guard?: Decision | null | undefined;
  /** Makes this the form's submit button: Enter submits. */
  submit?: boolean;
  /** Without onClick the action just closes the dialog. */
  onClick?: (close: () => void) => void;
}

export interface DialogOpts {
  title: ReactNode;
  kicker?: ReactNode;
  sub?: ReactNode;
  wide?: boolean;
  /** Extra class on the dialog panel (e.g. "dlg-palette"). */
  cls?: string;
  /** True while the body holds unsaved input: Escape, scrim and close ask before discarding. */
  dirty?: boolean;
  /** No corner close button (Escape, scrim and the footer still close). */
  bare?: boolean;
  body: ReactNode | ((close: () => void) => ReactNode);
  actions?: DialogAction[];
  onClose?: () => void;
}

export interface MenuItem {
  label?: string;
  icon?: string;
  hint?: string;
  /** "danger" or "andon" marks a destructive or stopping item. */
  kind?: string;
  sep?: boolean;
  guard?: Decision | null | undefined;
  onClick?: () => void;
}

/** Layout of an anchored popover: width, side of the anchor it aligns to, an extra class, and the ARIA role/label (menus use role "menu"). */
export interface PopoverOpts {
  width?: number;
  align?: "left" | "right";
  cls?: string;
  role?: "dialog" | "menu";
  label?: string;
}

export interface UIApi {
  /** A short notice. An action (e.g. Undo) keeps it up longer and runs once when pressed. */
  toast(text: string, kind?: ToastKind, action?: ToastAction): void;
  /** Push a custom modal onto the dialog stack. */
  open(render: (close: () => void) => ReactNode): { close: () => void };
  dialog(o: DialogOpts): { close: () => void };
  /** Closes the topmost dialog; false when none is open. */
  closeTopDialog(): boolean;
  closeAllDialogs(): void;
  drawer: {
    open(key: string, render: (close: () => void) => ReactNode): void;
    close(): void;
    isOpen(key?: string): boolean;
  };
  /** Popover anchored under a button. Returns its close function. */
  popover(anchor: HTMLElement, render: (close: () => void) => ReactNode, onClose?: () => void, opts?: PopoverOpts): () => void;
  menu(anchor: HTMLElement, title: string | null, items: MenuItem[]): () => void;
  closePopover(): void;
  /** Resolves true when the person confirms. */
  confirm(o: { title: string; body?: ReactNode; sub?: ReactNode; ok?: string; kind?: string; kicker?: string; bare?: boolean; cancelKind?: string }): Promise<boolean>;
  /** Reason prompt (legacy G.reasonDialog). onOk may return a refusal to show inline. */
  reasonDialog(o: {
    title: string;
    kicker?: string;
    sub?: string;
    label?: string;
    placeholder?: string;
    ok?: string;
    kind?: string;
    min?: number;
    guard?: Decision | null;
    extra?: ReactNode;
    onOk: (reason: string) => void | { ok: boolean; msg?: string } | Promise<void | { ok: boolean; msg?: string }>;
  }): void;
  /** Type-the-phrase confirmation (legacy G.typedConfirm). */
  typedConfirm(o: {
    title: string;
    kicker?: string;
    sub?: string;
    wide?: boolean;
    body?: ReactNode;
    phrase: string;
    okLabel?: string;
    kind?: string;
    guard?: Decision | null;
    onOk: (typed: string) => void | { ok: boolean; msg?: string } | Promise<void | { ok: boolean; msg?: string }>;
  }): void;
}

export const UIContext = createContext<UIApi | null>(null);

export function useUI(): UIApi {
  const v = useContext(UIContext);
  if (!v) throw new Error("useUI must be used under <OverlayProvider>");
  return v;
}
