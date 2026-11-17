/**
 * @mention in the work-order composer. Typing `@` and a few letters of a name offers the people the server finds (it also says who cannot read the project yet).
 * Picking one writes `@Name` into the message and remembers the person; only people whose `@Name` is still in the text when the message is sent are mentioned.
 * A mention is a notification: it never opens the project to anyone.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { api, get } from "../../api/client";

export interface Candidate { id: string; name: string; title: string; access: boolean }
export interface Picked { id: string; name: string }

/** The `@word` the caret is in, if any: where it starts and what was typed after the `@`. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|\s)@([\p{L}.'-]{0,30}(?: [\p{L}.'-]{0,30})?)$/u.exec(text.slice(0, caret));
  if (!m) return null;
  const query = m[1] ?? "";
  return { start: caret - query.length - 1, query };
}

/** The people still named in the text, as the ids to send. */
export const mentionIds = (text: string, picked: Picked[]): string[] => [...new Set(picked.filter((p) => text.includes(`@${p.name}`)).map((p) => p.id))];

export const useMentionCandidates = (woId: string, query: string | null) =>
  useQuery({
    queryKey: ["conversations", "mentionable", woId, query],
    queryFn: () => get<{ people: Candidate[] }>(api(`work-orders/${encodeURIComponent(woId)}/session/people`), { q: query ?? "" }),
    enabled: !!query,
    staleTime: 30_000,
    select: (r) => r.people,
  });

/** State and key handling for the composer: spread `props` on the textarea, render `<MentionList>` beside it. */
export function useMentions(woId: string, draft: string, setDraft: (v: string) => void, enabled: boolean) {
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const at = enabled ? mentionAt(draft, caret) : null;
  const open = !!at && at.query.length > 0 && dismissed !== at.start;
  const found = useMentionCandidates(woId, open ? at!.query : null);
  const list = useMemo(() => (open ? found.data ?? [] : []), [open, found.data]);
  useEffect(() => setActive(0), [at?.query]);

  const pick = (c: Candidate) => {
    if (!at) return;
    const next = `${draft.slice(0, at.start)}@${c.name} ${draft.slice(caret)}`;
    setDraft(next);
    setPicked((p) => [...p.filter((x) => x.id !== c.id), { id: c.id, name: c.name }]);
    setCaret(at.start + c.name.length + 2);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!list.length) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length); return true; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(list[active] ?? list[0]!); return true; }
    if (e.key === "Escape") { e.preventDefault(); setDismissed(at!.start); return true; }
    return false;
  };
  return { list, active, pick, onKeyDown, setCaret, ids: () => mentionIds(draft, picked), reset: () => setPicked([]), listId: `wos-mentions-${woId}`, open: list.length > 0 };
}

export function MentionList({ id, list, active, pick }: { id: string; list: Candidate[]; active: number; pick: (c: Candidate) => void }) {
  if (!list.length) return null;
  return (
    <ul className="wos-mentions" id={id} role="listbox" aria-label="People to mention">
      {list.map((c, i) => (
        <li key={c.id} id={`${id}-${i}`} role="option" aria-selected={i === active} className={i === active ? "is-active" : ""} onMouseDown={(e) => { e.preventDefault(); pick(c); }}>
          <span className="strong">{c.name}</span>
          {c.title ? <span className="muted small"> {c.title}</span> : null}
          {c.access ? null : <span className="muted small"> · cannot open this project yet</span>}
        </li>
      ))}
    </ul>
  );
}
