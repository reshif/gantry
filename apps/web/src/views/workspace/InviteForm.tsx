/** The invite dialog's form: pick a person who may read and post in a chat. Shared by the workspace chat header and the Console chat list. */
import { useState } from "react";
import { usePeople } from "../../api/queries";
import { Field, Select } from "../../ui/primitives";

export function InviteForm({ exclude, registerSubmit, onSave }: { exclude: string[]; registerSubmit: (fn: () => void) => void; onSave: (p: string) => Promise<string | null> }) {
  const people = usePeople();
  const opts = (people.data ?? []).filter((p) => !exclude.includes(p.id)).map((p) => ({ value: p.id, label: p.name }));
  const [v, setV] = useState("");
  const [err, setErr] = useState("");
  registerSubmit(() => { const id = v.trim(); if (!id) return setErr("Choose a person."); void onSave(id).then((e) => setErr(e ?? "")); });
  return (
    <div className="form-grid">
      {people.data ? (
        <Field label="Person" htmlFor="ws-invite-who" hint="They can read and post here. Someone who cannot see the project cannot be invited."><Select id="ws-invite-who" value={v} onChange={setV} options={[{ value: "", label: "Choose…" }, ...opts]} /></Field>
      ) : (
        <Field label="Person id" htmlFor="ws-invite-who" hint="For example p-meera. They can read and post here."><input id="ws-invite-who" className="input" value={v} onChange={(e) => setV(e.target.value)} /></Field>
      )}
      <div className="form-err" role="alert">{err}</div>
    </div>
  );
}
