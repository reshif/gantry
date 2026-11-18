/** The Channels tab: every connection that can receive notifications and is open to the project, with Send test (prototype setrow list). */
import type { Project } from "@gantry/domain";
import { ops } from "../../api/ops";
import { Btn, Empty, type Decision } from "../../ui/primitives";
import { Card } from "../../ui/cr";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { accepts, defaultTarget, instState, type useNtData } from "./kit";

type Nt = ReturnType<typeof useNtData>;

export function ChannelsTab({ p, nt, perm }: { p: Project; nt: Nt; perm: Decision }) {
  const ui = useUI();
  const send = async (i: (typeof nt.destInsts)[number]): Promise<void> => {
    const t = nt.typeOf(i.type);
    const target = defaultTarget(i.type, p, i);
    const ev = (t.events ?? []).find((e) => accepts(t, e)) ?? "submitted";
    const r = await ops.sendTest(p.id, { channel: i.type, target, integration: i.id }, "", ev);
    ui.toast(r.ok ? `Sent a test message to ${target || i.name}` : r.msg, r.ok ? "ok" : "error");
  };
  return (
    <Card title="Channels" flush id="nt-channels">
      {nt.destInsts.length ? (
        <div className="list">
          {nt.destInsts.map((i) => {
            const target = defaultTarget(i.type, p, i);
            const st = instState(i);
            return (
              <div className="setrow" key={i.id} id={`nt-ch-${i.id}`}>
                <div className="tx"><b>{nt.typeOf(i.type).name} <span className="mono dim">{target}</span></b><span>{i.name}, {st}</span></div>
                <Btn label="Send test" small id={`nt-ch-test-${i.id}`} guard={perm} onClick={() => void send(i)} />
              </div>
            );
          })}
        </div>
      ) : <Empty title="No channels connected" text="Connect Slack, email or a pager in Integrations, then choose which events reach it." action={<Btn label="Open Integrations" id="nt-go-int" onClick={() => navigate("integrations")} />} />}
    </Card>
  );
}
