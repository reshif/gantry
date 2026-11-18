/**
 * Add integration, the prototype form and nothing else: Type, Name and "Token or webhook secret", with the prototype's inline errors.
 * The type list is the prototype's (github, gitlab, slack, teams, jira, linear, paging, email, webhook, statuspage) as far as the
 * server's connector catalogue has it. The type's own settings (organisation, host, ...) are not asked here; the server refuses a
 * connection it cannot use and says why.
 */
import { useRef, useState } from "react";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Field, LockNote, Select, focusFirstInvalid, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { configOf, emptyVals, type TypeRow } from "./kit";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

/** The prototype's type list, in its order. */
export const PROTO_TYPES = ["github", "gitlab", "slack", "teams", "jira", "linear", "paging", "email", "webhook", "statuspage"] as const;

export function AddIntegration({ types, close }: { types: TypeRow[]; close: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("integration.add"));
  const root = useRef<HTMLDivElement>(null);
  const offered = PROTO_TYPES.map((id) => types.find((t) => t.id === id)).filter((t): t is TypeRow => !!t && t.available !== false);
  const [type, setType] = useState(offered[0]?.id ?? "github");
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [errs, setErrs] = useState<{ name?: string; secret?: string; form?: string }>({});

  const submit = async (): Promise<void> => {
    const e: typeof errs = {};
    if (!name.trim()) e.name = "Name is required.";
    else if (name.trim().length < 3) e.name = "Name needs at least 3 characters.";
    if (!secret) e.secret = "Token or webhook secret is required.";
    else if (secret.length < 8) e.secret = "Token or webhook secret needs at least 8 characters.";
    if (Object.keys(e).length) {
      setErrs(e);
      setTimeout(() => { if (root.current) focusFirstInvalid(root.current); }, 0);
      return;
    }
    const t = types.find((x) => x.id === type);
    const secretKey = t?.fields.find((f) => f.type === "secret")?.key;
    const r = await ops.addIntegration({ type, name: name.trim(), config: t ? configOf(t, emptyVals(t)) : {}, secrets: secretKey ? { [secretKey]: secret } : {}, projects: "all", enable: true });
    if (!r.ok) { setErrs({ form: r.msg }); return; }
    ui.toast(`Connected ${name.trim()}`, "ok");
    close();
  };

  return (
    <Dialog
      title="Add integration" dirty={!!(name || secret)} onClose={close}
      actions={[{ label: "Cancel", id: "int-add-cancel" }, { label: "Connect", kind: "primary", submit: true, id: "int-add-go", guard: perm, onClick: () => { void submit(); } }]}
      body={(
        <div className="form-grid" ref={root}>
          <LockNote decision={perm} what="Adding integrations" />
          <Field label="Type" htmlFor="int-add-type">
            <Select id="int-add-type" value={type} options={PROTO_TYPES.map((id) => { const ok = offered.some((t) => t.id === id); return { value: id, label: ok ? id : `${id} (not yet available)`, disabled: !ok }; })} onChange={setType} />
          </Field>
          <Field label="Name" htmlFor="int-add-name" error={errs.name}>
            <input id="int-add-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Token or webhook secret" htmlFor="int-add-secret" error={errs.secret} hint="Stored encrypted; never shown again.">
            <input id="int-add-secret" className="input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </Field>
          <div className="form-err" role="alert" id="int-add-err">{errs.form ?? ""}</div>
        </div>
      )}
    />
  );
}
