/** The Channels tab: every connection that can receive notifications and is open to the project, with Send test (prototype setrow list). */
import type { Project } from "@gantry/domain";
import { ops } from "../../api/ops";
import { Btn, Empty, type Decision } from "../../ui/primitives";
import { Card } from "../../ui/cr";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { accepts, defaultTarget, instState, type Route, type useNtData } from "./kit";

type Nt = ReturnType<typeof useNtData>;

/** The channels the matrix has columns for; other destinations (Teams, webhooks) are managed as routes. */
const MATRIX_TYPES = ["slack", "email", "paging"];
/** What a pager or chat connection is used for, by the events its routes send to it. */
const USED_FOR: Record<string, string> = { blocked: "stuck work", kill: "emergency stop", "gate.waiting": "waiting gates", question: "questions", submitted: "new work", released: "releases" };
const CHANNEL_NAME: Record<string, string> = { slack: "Slack", email: "Email", paging: "Pager" };
const WORD: Record<string, string> = { healthy: "connected" };

export function ChannelsTab({ p, nt, perm }: { p: Project; nt: Nt; perm: Decision }) {
  const chans = nt.destInsts.filter((i) => MATRIX_TYPES.includes(i.type));
  const ui = useUI();
  /** The target a channel row shows, and the one Send test uses and names: the first route destination on this connection, else the connection's default. */
  const targetOf = (i: (typeof nt.destInsts)[number]): string => (nt.routes as Route[]).filter((r) => r.enabled && r.dest.some((d) => d.integration === i.id)).flatMap((r) => r.dest).find((d) => d.integration === i.id)?.target || defaultTarget(i.type, p, i);
  const send = async (i: (typeof nt.destInsts)[number]): Promise<void> => {
    const t = nt.typeOf(i.type);
    const target = targetOf(i);
    const ev = (t.events ?? []).find((e) => accepts(t, e)) ?? "submitted";
    const r = await ops.sendTest(p.id, { channel: i.type, target, integration: i.id }, "", ev);
    ui.toast(r.ok ? `Sent a test message to ${target || i.name}` : r.msg, r.ok ? "ok" : "error");
  };
  return (
    <>
    <Card title="Channels" flush id="nt-channels">
      {chans.length ? (
        <div className="list">
          {chans.map((i) => {
            const mine = (nt.routes as Route[]).filter((r) => r.enabled && r.dest.some((d) => d.integration === i.id));
            const target = targetOf(i);
            const st = instState(i);
            const used = Array.from(new Set(mine.map((r) => USED_FOR[r.event]).filter(Boolean)));
            const ws = typeof i.config.workspace === "string" ? i.config.workspace : "";
            const sub = i.type === "paging" ? (used.length ? `Used for ${used.join(" and ")}` : `${i.name}, ${WORD[st] ?? st}`) : i.type === "slack" ? `${ws ? `Workspace ${ws}` : i.name}, bot ${WORD[st] ?? st}` : i.type === "email" ? `SMTP relay, ${WORD[st] ?? st}` : `${i.name}, ${WORD[st] ?? st}`;
            return (
              <div className="setrow" key={i.id} id={`nt-ch-${i.id}`}>
                <div className="tx"><b>{CHANNEL_NAME[i.type] ?? nt.typeOf(i.type).name} <span className="mono dim">{target}</span></b><span>{sub}</span></div>
                <Btn label="Send test" small id={`nt-ch-test-${i.id}`} guard={perm} onClick={() => void send(i)} />
              </div>
            );
          })}
        </div>
      ) : <Empty title="No channels connected" text="Connect Slack, email or a pager in Integrations, then choose which events reach it." action={<Btn label="Open Integrations" id="nt-go-int" onClick={() => navigate("integrations")} />} />}
    </Card>
    </>
  );
}
