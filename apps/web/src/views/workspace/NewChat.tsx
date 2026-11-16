/**
 * New chat: choose what it is about (the factory, or one work order) and who answers (the Console assistant, or a station's agent such as the
 * Researcher). A chat about a work order is read by its project by default, as its primary thread is; a factory chat is private.
 */
import { useState } from "react";
import { Field, Select } from "../../ui/primitives";
import { useWsAgents, type InboxItem } from "./api";

export interface NewChatChoice { scope: { kind: "factory" | "work_order"; id: string | null }; agent: string | null; visibility: "private" | "project" }

export function NewChatForm({ wos, initialWo, registerSubmit, onSave }: { wos: InboxItem[]; initialWo: string | null; registerSubmit: (fn: () => void) => void; onSave: (c: NewChatChoice) => Promise<string | null> }) {
  const [about, setAbout] = useState<string>(initialWo ? `wo:${initialWo}` : "factory");
  const wo = about.startsWith("wo:") ? about.slice(3) : null;
  const agents = useWsAgents(wo);
  const [agent, setAgent] = useState<string>("");
  const [shared, setShared] = useState(true);
  const [err, setErr] = useState("");
  registerSubmit(() => {
    setErr("");
    void onSave({ scope: wo ? { kind: "work_order", id: wo } : { kind: "factory", id: null }, agent: wo ? agent || null : null, visibility: wo && shared ? "project" : "private" }).then((e) => setErr(e ?? ""));
  });
  const woOpts = wos.filter((w) => w.kind === "primary" && !w.archived).map((w) => ({ value: w.key, label: `${w.scope.id} · ${w.title.slice(0, 60)}` }));
  return (
    <div className="form-grid">
      <Field label="About" htmlFor="ws-new-about" hint={wo ? "The agent reads this work order's documents, questions and sources." : "A chat with the Console about anything you can see in the factory."}>
        <Select id="ws-new-about" value={about} onChange={(v) => { setAbout(v); setAgent(""); }} options={[{ value: "factory", label: "The factory (Console)" }, ...woOpts]} />
      </Field>
      {wo ? (
        <Field label="Talk to" htmlFor="ws-new-agent" hint="The station agent answers in its own voice. It cannot change the work order from here.">
          <Select id="ws-new-agent" value={agent} onChange={setAgent} options={[{ value: "", label: "Gantry assistant" }, ...(agents.data?.items ?? []).map((a) => ({ value: a.id, label: `${a.name} (${a.stationName})` }))]} />
        </Field>
      ) : null}
      {wo ? (
        <label className="check-row small" htmlFor="ws-new-shared">
          <input type="checkbox" id="ws-new-shared" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          <span>Let everyone who can see the project read it (only you and people you invite post)</span>
        </label>
      ) : null}
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}
