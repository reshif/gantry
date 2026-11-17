/**
 * People's side of a station document: comments on a section, and a direct edit that saves a new version in the person's name.
 * Rights are the server's; a refusal comes back as the toast. The agent reads the open comments the next time the station runs.
 */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { Btn, Who } from "../../ui/primitives";
import { useCommand } from "../../ui/async";
import { commentOnDocument, editDocument, resolveDocComment, type DocComment, type DocVersion } from "./api";

export function DocComments({ woId, version, sections, items }: { woId: string; version: DocVersion; sections: string[]; items: DocComment[] }) {
  const [section, setSection] = useState("");
  const [text, setText] = useState("");
  const add = useCommand(() => commentOnDocument(woId, version.id, { text: text.trim(), ...(section ? { section } : {}) }));
  const resolve = useCommand((id: string) => resolveDocComment(woId, id));
  const open = items.filter((c) => c.status === "open").length;
  return (
    <section className="doc-comments" id="doc-comments" aria-label="Comments">
      <header className="doc-comments-h">
        <strong>Comments</strong>
        <span className="small muted">{items.length ? `${open} open` : "None yet"}</span>
      </header>
      {items.length ? (
        <ul className="doc-comment-list">
          {items.map((c) => (
            <li key={c.id} className={`doc-comment is-${c.status}`} id={`doc-comment-${c.id}`}>
              <p className="small muted doc-comment-meta">
                <Who id={c.author} />{` · ${c.section ? `on “${c.section}”` : "on the whole document"} · version ${c.version} · ${fmt.stamp(c.createdAt)}`}
                {c.status === "resolved" ? " · resolved" : ""}
              </p>
              <p className="doc-comment-body">{c.body}</p>
              {c.status === "open" ? <Btn small id={`doc-comment-resolve-${c.id}`} label="Resolve" disabledReason={resolve.wait()} onClick={() => void resolve.run(c.id)} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="doc-comment-form">
        <label className="small" htmlFor="doc-comment-section">Comment on</label>
        <select id="doc-comment-section" className="input" value={section} onChange={(e) => setSection(e.target.value)}>
          <option value="">The whole document</option>
          {sections.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label className="small" htmlFor="doc-comment-text">Your comment</label>
        <textarea id="doc-comment-text" className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
        <div>
          <Btn small kind="primary" id="doc-comment-add" label="Add comment" disabledReason={!text.trim() ? "Write the comment first." : add.wait()} onClick={async () => { const r = await add.run(); if (r?.ok) setText(""); }} />
        </div>
      </div>
    </section>
  );
}

export function DocEditor({ woId, version, text, onDone }: { woId: string; version: DocVersion; text: string; onDone: (newVersionId?: string) => void }) {
  const [draft, setDraft] = useState(text);
  const [why, setWhy] = useState("");
  const save = useCommand(() => editDocument(woId, version.id, { markdown: draft, ...(why.trim() ? { note: why.trim() } : {}) }));
  return (
    <div className="doc-editor" id="doc-editor">
      <label className="small" htmlFor="doc-edit-text">{`Edit ${version.doc}`}</label>
      <textarea id="doc-edit-text" className="input mono doc-edit-text" rows={18} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <label className="small" htmlFor="doc-edit-why">What did you change? (optional)</label>
      <input id="doc-edit-why" className="input" value={why} onChange={(e) => setWhy(e.target.value)} />
      <div className="osx-actions">
        <Btn small kind="primary" id="doc-edit-save" label="Save as a new version" disabledReason={draft === text ? "Nothing changed yet." : save.wait("Saving…")} onClick={async () => { const r = await save.run(); if (r?.ok) onDone(typeof r.id === "string" ? r.id : undefined); }} />
        <Btn small id="doc-edit-cancel" label="Cancel" onClick={() => onDone()} />
      </div>
    </div>
  );
}
