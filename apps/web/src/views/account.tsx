/**
 * Account: the signed-in person's own page. Profile (read-only, managed in People), the roles they hold, their sessions,
 * preferences kept in this browser, and the chat account linked to them.
 */
import { useState } from "react";
import { fmt, ROLES } from "@gantry/domain";
import { commands as ops } from "../api/commands";
import { useChatLinks, useMe, useSessions } from "../api/queries";
import { navigate } from "../lib/router";
import { applyTheme, updatePrefs, usePrefs, type Theme } from "../lib/prefs";
import { canSeeRoute } from "../lib/routes";
import type { Me } from "../api/types";
import { Avatar, Btn, Empty, Panel, Segmented, Status, Tabs, ViewHead } from "../ui/primitives";
import { Async } from "../ui/async";
import { DataTable, type Col } from "../ui/DataTable";
import { Icon } from "../ui/Icon";
import { useUI } from "../ui/overlay-context";
import { useTeams } from "./govern/data";

const TABS = [{ id: "profile", label: "Profile" }, { id: "access", label: "My access" }, { id: "sessions", label: "Sessions" }, { id: "prefs", label: "Preferences" }, { id: "linked", label: "Linked accounts" }];

export default function AccountView() {
  const me = useMe();
  const [tab, setTab] = useState("profile");
  if (!me) return null;
  return (
    <div className="view view-account">
      <ViewHead title="Account" sub="Who you are signed in as, what you may do, where you are signed in and how Gantry looks for you." />
      <Tabs idPrefix="acct-tab" active={tab} onChange={setTab} items={TABS} />
      <div id="acct-tab-panel" role="tabpanel" className="acct-body">
        {tab === "profile" ? <ProfileTab me={me} /> : tab === "access" ? <AccessTab me={me} /> : tab === "sessions" ? <SessionsTab me={me} /> : tab === "prefs" ? <PrefsTab /> : <LinkedTab />}
      </div>
    </div>
  );
}

function ProfileTab({ me }: { me: Me }) {
  const v = me.person;
  const teamsData = useTeams().data;
  const teams = teamsData ?? [];
  const names = v.teams.map((id) => teams.find((t) => t.id === id)?.name ?? id);
  const rows: Array<[string, React.ReactNode]> = [
    ["Title", v.title || "Not set"],
    ["Email", <span className="mono" key="e">{v.email}</span>],
    ["GitHub", v.github ? <span className="mono" key="g">{v.github}</span> : <span className="muted">not linked</span>],
    ["Teams", names.join(", ") || "No team"],
    ["On call", v.oncall ? "Yes" : "No"],
    ["Signed in via", <span key="m">{me.session.method} <Status tone="accent" icon={null}>this session</Status></span>],
  ];
  return (
    <Panel title="Profile">
      <p className="muted small acct-hint">Read-only. Your name, title and teams are managed in People &amp; teams.</p>
      <div className="acct-who"><Avatar id={v.id} size="lg" /><strong>{v.name}</strong></div>
      <dl className="acct-kv">
        {rows.map(([k, val]) => <div key={k}><dt>{k}</dt><dd>{val}</dd></div>)}
      </dl>
      <div className="acct-act">
        {canSeeRoute("people", me) ? <Btn label="Open in People" icon="user" id="acct-open-person" onClick={() => navigate("person", v.id)} /> : <span className="muted small">To change these details ask a Factory Admin.</span>}
      </div>
    </Panel>
  );
}

function AccessTab({ me }: { me: Me }) {
  const roles = me.person.roles;
  const teamsData = useTeams().data;
  const teams = teamsData ?? [];
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  const roleCols: Array<Col<(typeof roles)[number]>> = [
    { key: "scope", label: "Scope", render: (g) => (g.scope === "factory" ? "Factory" : me.projects.find((p) => p.id === g.scope)?.name ?? g.scope) },
    { key: "role", label: "Role", render: (g) => <span className="chip">{ROLES.find((r) => r.id === g.role)?.name ?? g.role}</span> },
    { key: "via", label: "Granted", render: (g) => (g.via ? <span className="muted">{`via team ${teamName(g.via)}`}</span> : "Directly") },
  ];
  return (
    <Panel title="My access" flush>
      <p className="muted small acct-hint acct-hint-pad">Roles are granted at factory level or per project. Projects where you hold no role are hidden from you.</p>
      {roles.length ? (
        <DataTable id="acct-roles" caption="My roles" columns={roleCols} rows={roles} rowKey={(g) => `${g.scope}-${g.role}-${g.via ?? ""}`} />
      ) : <Empty id="acct-no-roles" icon="lock" title="No roles yet" text="Nothing has been granted to you. A Factory Admin or Project Admin can give you a role." />}
    </Panel>
  );
}

type SessionRow = NonNullable<ReturnType<typeof useSessions>["data"]>[number];
const sessionCols = (currentId: string, revoke: (id: string) => Promise<void>): Array<Col<SessionRow>> => [
  { key: "device", label: "Device", render: (x) => x.device },
  { key: "method", label: "Method", render: (x) => <span className="mono">{x.method}</span> },
  { key: "ip", label: "IP", render: (x) => <span className="mono">{x.ip}</span> },
  { key: "started", label: "Started (IST)", render: (x) => <span className="mono nowrap">{`${fmt.istDate(x.started)} ${fmt.ist(x.started)}`}</span> },
  { key: "lastSeen", label: "Last seen", render: (x) => <span className="nowrap">{fmt.ago(x.lastSeen, Date.now())}</span> },
  { key: "state", label: "State", render: (x) => (x.id === currentId || x.current ? <Status tone="accent" icon="check">This session</Status> : <Status tone="done" icon="check">Active</Status>) },
  { key: "act", label: "", render: (x) => (x.id === currentId || x.current ? null : <Btn label="Revoke" small id={`acct-rev-${x.id}`} onClick={() => void revoke(x.id)} />) },
];

function SessionsTab({ me }: { me: Me }) {
  const ui = useUI();
  const q = useSessions();
  const revoke = async (id: string) => {
    const r = await ops.revokeSession(id);
    ui.toast(r.msg, r.ok ? "ok" : "error");
  };
  return (
    <Panel title="My sessions" flush>
      <p className="muted small acct-hint acct-hint-pad">Where you are signed in. You can end any of them. Security shows everyone's sessions in the same table.</p>
      <Async query={q} what="your sessions" id="acct-sessions">{(all) => {
        const mine = all.filter((s) => s.person === me.person.id && !s.revoked).sort((a, b) => b.lastSeen - a.lastSeen);
        return mine.length ? (
          <DataTable id="acct-sessions-table" caption="My sessions" columns={sessionCols(me.session.id, revoke)} rows={mine} rowKey={(x) => x.id} />
        ) : <Empty id="acct-no-sessions" icon="key" title="No other sessions" text="You are not signed in anywhere else." />;
      }}</Async>
    </Panel>
  );
}

function PrefsTab() {
  const prefs = usePrefs();
  const ui = useUI();
  const setTheme = (t: Theme) => {
    updatePrefs({ theme: t });
    applyTheme(t);
    ui.toast(`Theme set to ${t}.`, "ok");
  };
  return (
    <Panel title="Preferences">
      <p className="muted small acct-hint">Saved in this browser and kept the next time you come back.</p>
      <div className="acct-setrow">
        <div className="acct-setrow-main"><label htmlFor="acct-theme">Theme</label><span className="muted small">System follows your device. The menu under your avatar changes the same setting.</span></div>
        <Segmented name="acct-theme" label="Theme" value={prefs.theme} onChange={(v) => setTheme(v as Theme)} items={[{ id: "system", label: "System" }, { id: "light", label: "Light" }, { id: "dark", label: "Dark" }]} />
      </div>
      <p className="muted small acct-hint">Pinned projects, recent items and the navigation state are remembered the same way. Clearing site data resets them.</p>
    </Panel>
  );
}

function LinkedTab() {
  const ui = useUI();
  const q = useChatLinks();
  const [code, setCode] = useState<{ command: string } | null>(null);
  const request = async () => {
    const r = await ops.requestChatLink("slack");
    if (!r.ok) return ui.toast(r.msg, "error");
    setCode({ command: r.command });
  };
  return (
    <Panel title="Linked accounts">
      <p className="muted small acct-hint">Link your chat account so you can answer and approve from Slack. Only the id of your chat account is kept, never a secret.</p>
      <Async query={q} what="linked accounts" id="acct-links">{(all) => {
        const links = all.filter((l) => l.channel === "slack");
        return (
          <div className="acct-links">
            <div className="acct-linkhead"><strong>Slack</strong><Status tone={links.length ? "done" : "neutral"} icon={null}>{`${links.length} linked`}</Status></div>
            {links.length ? (
              <ul className="acct-linklist" id="acct-link-list">
                {links.map((l) => (
                  <li key={l.id}>
                    <span className="mono">{l.externalId}</span>
                    <span className="muted small">{l.verifiedAt ? `verified ${fmt.ago(l.verifiedAt, Date.now())}` : "waiting for the code"}</span>
                    <Btn label="Unlink" small icon="x" id={`acct-unlink-${l.id}`} onClick={async () => { const r = await ops.removeChatLink(l.id); ui.toast(r.msg, r.ok ? "ok" : "error"); }} />
                  </li>
                ))}
              </ul>
            ) : <p className="muted small">Your Slack account is not linked.</p>}
            <div className="acct-act"><Btn label={links.length ? "Link again" : "Link my Slack account"} kind="primary" icon="link" id="acct-link" onClick={() => void request()} /></div>
            {code ? (
              <div className="callout callout-ok" role="status" id="acct-linkcode"><Icon name="check" /><span>In Slack, send <span className="mono">{code.command}</span> within 10 minutes. The code works once.</span></div>
            ) : null}
          </div>
        );
      }}</Async>
    </Panel>
  );
}
