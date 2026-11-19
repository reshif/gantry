import "../lib/data.css";
import type { DraftConflict as Conflict } from "../lib/useDraft";
import { Btn } from "./primitives";

/** A save made of several writes that stopped halfway: what did go through and what did not, in the words the person knows. */
export interface SavedParts { done: string[]; left: string[] }

/** The 409/412 and remote-change banner for a `useDraft`: say what happened, offer both ways out. Renders nothing without a conflict. */
export function DraftConflictBanner({ conflict, onKeepMine, onDiscard, id, saved }: { conflict: Conflict | null; onKeepMine: () => void; onDiscard: () => void; id?: string; saved?: SavedParts }) {
  if (!conflict) return null;
  const fields = conflict.keys.length ? ` (${conflict.keys.join(", ")})` : "";
  return (
    <div className="draft-conflict" role="alert" id={id}>
      <span>
        {saved && saved.done.length
          ? `Someone changed this partway through, so only part of your save went through. Saved: ${saved.done.join(", ")}. Not saved: ${saved.left.join(", ") || "nothing else"}. The screen has been reloaded; check it and save again.`
          : conflict.keys.length
          ? `Someone else changed ${conflict.keys.length === 1 ? "a field" : "fields"} you were editing${fields}. Nothing was saved.`
          : "This changed since you opened it, so your save was not applied. Nothing was overwritten."}
      </span>
      <span className="draft-conflict-actions">
        <Btn small label="Keep my version" id={id ? `${id}-mine` : undefined} onClick={onKeepMine} />
        <Btn small kind="ghost" label="Load their version" id={id ? `${id}-theirs` : undefined} onClick={onDiscard} />
      </span>
    </div>
  );
}
