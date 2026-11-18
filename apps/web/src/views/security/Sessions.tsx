/** Security, Sessions tab (prototype "Active sessions"): search by person or device, sortable columns, Revoke with a confirmation. */
import type { SecuritySettings, Session } from "@gantry/domain";
import { revokeSession } from "./commands";
import { useActors } from "../../ui/actors";
import { DataTable, type Col } from "../../ui/DataTable";
import { Btn, Chip, Panel, type Decision } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { lockd, useOutcome } from "../govern/data";
import { ListBar, agoShort } from "../govern/listkit";
import { useQueryParam } from "../floor/urlState";

export function SessionsTab({ perm, sessions, currentId, viewerId }: { perm: Decision; sessions: Session[]; sec: SecuritySettings; currentId: string; viewerId: string }) {
  const ui = useUI();
  const outcome = useOutcome();
  const actor = useActors();
  const [qp, setQ] = useQueryParam("sq");
  const q = qp ?? "";
  const name = (id: string) => actor(id).name.replace(" (agent)", "");
  const needle = q.trim().toLowerCase();
  const rows = sessions.filter((s) => !needle || `${name(s.person)}${s.device}`.toLowerCase().includes(needle));
  const others = sessions.filter((x) => !x.revoked && x.id !== currentId);
  const now = Date.now();

  const revoke = (s: Session) => {
    if (s.id === currentId) {
      ui.dialog({
        title: "Revoke your current session?", kicker: "Sessions", sub: "This signs you out of this browser now.", body: null,
        actions: [{ label: "Cancel" }, { label: "Revoke and sign out", kind: "danger", id: "sec-ses-self-ok", onClick: (close) => { close(); void revokeSession(s.id).then((r) => { if (r.ok) { ui.closeAllDialogs(); ui.toast("Session revoked. You are signed out.", "warn"); } else outcome(r); }); } }],
      });
      return;
    }
    ui.dialog({
      title: "Revoke this session?", kicker: "Sessions", sub: `${name(s.person)} is signed out on ${s.device}.`, body: null,
      actions: [{ label: "Cancel" }, { label: "Revoke", kind: "danger", id: "sec-ses-ok", onClick: (close) => { close(); void revokeSession(s.id).then((r) => outcome(r, "Session revoked")); } }],
    });
  };

  const cols: Col<Session>[] = [
    { key: "p", label: "Person", sort: (s) => name(s.person).toLowerCase(), render: (s) => <span className="who">{name(s.person)}</span> },
    { key: "d", label: "Device", render: (s) => s.device },
    { key: "m", label: "Method", render: (s) => <Chip text={s.method} cls="plain" /> },
    { key: "s", label: "Started", sort: (s) => s.started, render: (s) => agoShort(s.started, now) },
    { key: "l", label: "Last seen", render: (s) => agoShort(s.lastSeen, now) },
    { key: "x", label: "", align: "end", render: (s) => {
      if (s.revoked) return <Chip text="revoked" cls="bad" />;
      const own = s.person === viewerId;
      const g = !perm.allowed && !own ? perm : null;
      return <Btn label="Revoke" small kind="danger" id={`sec-ses-rv-${s.id}`} guard={g} aria={`Revoke ${name(s.person)} on ${s.device}`} onClick={() => revoke(s)} />;
    } },
  ];

  return (
    <Panel title="Active sessions" flush id="sec-sessions-panel">
      <ListBar
        id="sec-ses" label="Sessions" q={q} onQ={(v) => setQ(v || null)} filters={[]} shown={rows.length} total={sessions.length} noun="session" onClear={() => setQ(null)}
        extra={<Btn label="Revoke all other sessions" kind="danger" small icon="logout" id="sec-ses-all"
          guard={!perm.allowed ? perm : !others.length ? lockd("No other active sessions.") : null}
          onClick={() => ui.dialog({
            title: `Revoke ${others.length} sessions?`, kicker: "Sessions", sub: "Everyone except you is signed out and must sign in again.", body: null,
            actions: [{ label: "Cancel" }, { label: `Revoke ${others.length}`, kind: "danger", id: "sec-ses-all-ok", onClick: (close) => void (async () => { let n = 0; for (const x of others) if ((await revokeSession(x.id)).ok) n++; close(); ui.toast(`${n} sessions revoked.`, "ok"); })() }],
          })} />}
      />
      <DataTable sortHint id="sec-ses-table" caption="Active sessions" columns={cols} rows={rows} rowKey={(s) => s.id} pageSize={12} pager
        empty={sessions.length ? { title: "Nothing matches these filters", text: "Loosen the search or clear the filters.", action: <Btn label="Clear filters" id="sec-ses-empty-clear" onClick={() => setQ(null)} /> } : { title: "Nothing here yet", text: "Items will appear here when they exist." }} />
    </Panel>
  );
}

