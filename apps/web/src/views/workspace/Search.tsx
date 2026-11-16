/** Search results in the workspace: messages, documents, sources and questions the person may read, with the matching words marked. */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import { Async } from "../../ui/async";
import { Btn, Empty, Who } from "../../ui/primitives";
import { snippetParts, useSearch, type Hit } from "./api";

const KINDS: Array<{ id: string; label: string }> = [{ id: "", label: "Everything" }, { id: "message", label: "Messages" }, { id: "document", label: "Documents" }, { id: "source", label: "Sources" }, { id: "question", label: "Questions" }];
const KIND_LABEL: Record<Hit["kind"], string> = { message: "Message", document: "Document", source: "Source", question: "Question" };

export function SearchResults({ q, onOpen, onClose }: { q: string; onOpen: (key: string) => void; onClose: () => void }) {
  const [kind, setKind] = useState("");
  const r = useSearch(q, kind);
  const items = r.data?.items ?? [];
  return (
    <section className="ws-results" aria-label={`Search results for ${q}`} id="ws-results">
      <header className="ws-chat-h">
        <h2 className="ws-chat-title">{`Search: “${q}”`}</h2>
        <span className="osx-spacer" />
        <Btn small kind="ghost" icon="x" id="ws-results-close" label="Close" onClick={onClose} />
      </header>
      <div className="ws-filters ws-kind-filters" role="tablist" aria-label="Kind">
        {KINDS.map((k) => <button key={k.id || "all"} type="button" role="tab" id={`ws-k-${k.id || "all"}`} aria-selected={kind === k.id} className={`ws-filter${kind === k.id ? " is-active" : ""}`} onClick={() => setKind(k.id)}>{k.label}</button>)}
      </div>
      <Async query={r} what="search results" id="ws-search">{() => items.length ? (
        <ul className="ws-hits">
          {items.map((h) => (
            <li key={`${h.kind}:${h.key}:${h.ref}`}>
              <button type="button" className="ws-hit" id={`ws-hit-${h.kind}-${h.ref}`} onClick={() => onOpen(h.key)}>
                <span className="ws-hit-top"><span className={`ws-hit-kind is-${h.kind}`}>{KIND_LABEL[h.kind]}</span><span className="ws-hit-title">{h.title}</span><span className="mono muted small">{fmt.istDate(h.at)}</span></span>
                <span className="ws-hit-snip small">{snippetParts(h.snippet).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</span>
                {h.by ? <span className="ws-hit-by small muted"><Who id={h.by} /></span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : <Empty id="ws-no-hits" icon="search" title="Nothing found" text="Search covers messages in every conversation you can read, station documents, the sources agents read and the questions they asked. Try other words." />}</Async>
    </section>
  );
}
