/** One intake conversation: classification with override, the thread with quick-reply chips and free text, the follow-up question, confirm and decline (legacy G.renderConversation). */
import { useEffect, useRef, useState } from "react";
import { fmt } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useMe } from "../../api/queries";
import { Btn, Avatar, Field, LockNote, StateChip } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useActors } from "../../ui/actors";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { setProject, updatePrefs } from "../../lib/prefs";
import { useOpenTraveler } from "../../shell/useTraveler";
import { ClassChip, GateDiamond, classOf, useCatalog } from "../projects/kit";
import { ConfMeter, ReclassifyDialog } from "../work-orders/intake";
import { useProject } from "../../api/queries";
import { dec as decOf, no, stName, useTravelerWo, type TWo } from "../traveler/model";
import { useOpenRecordRoute } from "../record/nav";
import { FU_MAX, atIntake, convStatus, raisedOpen } from "./model";

const drafts: Record<string, string> = {};
const lastCount: Record<string, number> = {};

export function StatusChip({ wo }: { wo: TWo | import("@gantry/domain").WorkOrder }) {
  const cat = useCatalog();
  const s = convStatus(wo, cat);
  return (
    <span className={`conv-st conv-st-${s.id}`}>
      <Icon name={s.glyph} />
      <span>{s.text}</span>
    </span>
  );
}

export function ConversationThread({ woId, idPrefix = "conv", head, noActions, noFollowup }: { woId: string; idPrefix?: string; head?: boolean; noActions?: boolean; noFollowup?: boolean }) {
  const pre = idPrefix.endsWith("-") ? idPrefix : `${idPrefix}-`;
  const ui = useUI();
  const me = useMe();
  const cat = useCatalog();
  const actor = useActors();
  const q = useTravelerWo(woId);
  const wo = q.data;
  const project = useProject(wo?.project).data;
  const openTraveler = useOpenTraveler();
  const openRecord = useOpenRecordRoute();
  const [text, setText] = useState(drafts[woId] ?? "");
  const [busy, setBusy] = useState(false);
  const [fu, setFu] = useState<{ text: string; chips: string } | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const n = wo?.conv.messages.length ?? 0;
  useEffect(() => {
    setText(drafts[woId] ?? "");
    setFu(null);
  }, [woId]);
  useEffect(() => {
    const key = pre + woId;
    const el = list.current;
    if (el && lastCount[key] !== n) {
      el.scrollTop = el.scrollHeight;
      lastCount[key] = n;
    }
  }, [n, pre, woId]);
  if (q.isLoading) return <p className="muted small" role="status">Loading the conversation…</p>;
  if (!wo || !cat || !project) return <div className="empty"><div className="empty-title">No such work order</div><p>It may have been removed, or it belongs to a project you cannot see.</p></div>;
  const conv = wo.conv;
  const mine = actor(me?.person.id).id;
  const answerD = decOf(wo, "answer");
  const canAnswer = answerD.allowed || wo.requestedBy === me?.person.id ? { allowed: true, reason: "" } : answerD;
  const stop = wo.stop;
  const intake = atIntake(wo);
  const raised = raisedOpen(wo);
  const lastQ = conv.messages.reduce((a, m, i) => (m.qid ? i : a), -1);
  const curQ = conv.questions[conv.qi];
  const showChips = intake && !conv.done && !raised.length && !!curQ;
  const closed = !intake && !raised.length && wo.bay !== "person";
  const stopD = stop ? no(`${stop.reason || "Stopped"} (${stop.scope} ${stop.mode === "halt" ? "halted" : "killed"})`) : null;
  const send = async (t: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const r = await ops.answer(wo.id, t);
    setBusy(false);
    if (r.ok) {
      drafts[wo.id] = "";
      setText("");
      if (r.msg !== "Answer recorded.") ui.toast(r.msg, "ok");
    } else ui.toast(r.msg, "error");
  };
  const submit = () => {
    if (!text.trim()) {
      ui.toast("Write an answer first.", "warn");
      return;
    }
    void send(text);
  };
  const clsD = decOf(wo, "classify");
  const confirmD = wo.allowed.approve?.gate === "G0G1" ? wo.allowed.approve : decOf(wo, "confirm");
  const declineD = decOf(wo, "decline");
  const openQs = conv.questions.length - conv.qi;
  const used = conv.questions.filter((x) => (x as { followup?: boolean }).followup).length;
  const addFollowup = async () => {
    if (!fu || busy) return;
    if (!fu.text.trim()) {
      ui.toast("Write the question first.", "warn");
      return;
    }
    setBusy(true);
    const chips = fu.chips.split(";").map((x) => x.trim()).filter(Boolean).slice(0, 3);
    const r = await ops.addFollowup(wo.id, { text: fu.text.trim(), chips, mode: "person" });
    setBusy(false);
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (r.ok) setFu(null);
  };
  const raiseQ = () =>
    ui.reasonDialog({
      title: `Raise a question on ${wo.id}`,
      kicker: "Intake · question for a person",
      sub: "The work order leaves the belt and waits in Needs a person until someone answers in this conversation.",
      label: "Question",
      ok: "Raise question",
      min: 5,
      placeholder: "What do you need a person to decide?",
      guard: stopD ?? decOf(wo, "park"),
      onOk: async (v) => {
        const r = await ops.raiseQuestionAtIntake(wo.id, v);
        if (r.ok) ui.toast(r.msg, "ok");
        return r;
      },
    });
  const decline = () =>
    ui.reasonDialog({
      title: `Decline ${wo.id}`,
      kicker: "Intake · decline",
      sub: "The work order moves to the Declined bay. The submitter sees your reason.",
      label: "Reason",
      ok: "Decline work order",
      kind: "danger",
      min: 5,
      placeholder: "For example: duplicate of WO-2398.",
      onOk: async (v) => {
        const r = await ops.decline(wo.id, v, undefined, { ifMatch: wo.version });
        if (r.ok) ui.toast(r.msg, "warn");
        return r;
      },
    });
  const confirm = async () => {
    const r = await ops.confirmBrief(wo.id, undefined, { ifMatch: wo.version });
    ui.toast(r.msg, r.ok ? "ok" : "error");
  };
  const ovr = wo.clsOverridden;
  const awaitNote = (conv.awaiting === "slack" || conv.awaiting === "api") && !conv.done && intake;
  return (
    <div className="conv-thread">
      {head ? (
        <div className="conv-head">
          <div className="conv-head-id">
            <span className="mono big-id">{wo.id}</span>
            <StateChip state={wo.state} />
            <StatusChip wo={wo} />
          </div>
          <h2 className="conv-title">{wo.title}</h2>
          <p className="small muted">{`${wo.repo} · requested by ${actor(wo.requestedBy).name} via ${wo.source} · ${fmt.ago(wo.createdAt, Date.now())}`}</p>
          <div className="conv-head-btns">
            <Btn label="Open traveler" small kind="ghost" icon="page" id={`${pre}trav-${wo.id}`} onClick={() => openTraveler(wo.id)} />
            <Btn label="Open full record" small kind="ghost" icon="record" id={`${pre}rec-${wo.id}`} onClick={() => openRecord(wo.id, wo.project)} />
          </div>
        </div>
      ) : null}
      <div className="conv-cls">
        <div className="conv-cls-row">
          <span className="kicker">Class</span>
          <ClassChip cls={classOf(cat, project, wo.cls)} />
          <ConfMeter c={wo.clsConfidence} />
          <Btn label="Change class" small icon="swap" id={`${pre}reclass-${wo.id}`} guard={stopD ?? clsD} disabledReason={clsD.allowed && !stop && !intake ? "Class can only change at Intake" : null} onClick={() => void ui.open((close) => <ReclassifyDialog woId={wo.id} onClose={close} />)} />
        </div>
        <p className="small conv-cls-why">{wo.clsRationale}</p>
        {ovr ? (
          <p className="small conv-ovr">
            <Icon name="swap" />
            {` Overridden from ${classOf(cat, project, ovr.from).name} by ${actor(ovr.by).name}, ${fmt.stamp(ovr.at)}${ovr.reason ? `: ${ovr.reason}` : ""}.`}
          </p>
        ) : null}
      </div>
      {wo.bay === "declined" ? (
        <div className="callout callout-fail">
          <Icon name="x" />
          <div>
            <strong>Declined. </strong>
            {wo.bayReason}
          </div>
        </div>
      ) : wo.state === "killed" ? (
        <div className="callout callout-fail">
          <Icon name="st-kill" />
          <div>
            <strong>Killed. </strong>
            {wo.killed ? wo.killed.reason : ""}
          </div>
        </div>
      ) : null}
      {raised.length ? (
        <div className="callout callout-warn">
          <Icon name="human" />
          <div>
            <strong>{`${stName(cat, raised[0]!.station)} needs an answer. `}</strong>
            {raised[0]!.text}
            <div className="small muted">The work order waits in Needs a person until someone answers below.</div>
          </div>
        </div>
      ) : null}
      {awaitNote ? (
        <div className="callout">
          <Icon name={conv.awaiting === "slack" ? "slack" : "api"} />
          <div className="small">{`The submitter answers through ${conv.awaiting === "slack" ? "Slack" : conv.awaiting === "api" ? "the API caller" : conv.awaiting}. Answers given here are recorded the same way.`}</div>
        </div>
      ) : null}
      <ol className="conv-msgs" id={`${pre}msgs-${wo.id}`} aria-label="Messages" tabIndex={0} ref={list}>
        {conv.messages.map((m, i) => {
          const a = actor(m.from);
          const scripted = m.scripted === true || m.from === "system";
          const isAgent = !scripted && (a.kind === "agent" || m.from.startsWith("ag-"));
          const sys = scripted || m.from === "ag-classifier";
          const cur = showChips && i === lastQ && m.qid === curQ?.id;
          return (
            <li key={`${m.at}-${i}`} className={`conv-msg${isAgent ? " is-agent" : " is-person"}${m.from === mine ? " is-mine" : ""}${sys ? " is-sys" : ""}${cur ? " is-current" : ""}`}>
              <div className="conv-msg-av"><Avatar id={m.from} size="sm" /></div>
              <div className="conv-bubble">
                <div className="conv-meta">
                  <strong>{m.from === mine ? "You" : scripted ? "Gantry" : a.name.replace(" (agent)", "")}</strong>
                  {isAgent ? <span className="conv-tag mono">agent</span> : null}
                  {scripted ? <span className="conv-tag mono">rule-based</span> : null}
                  <span className="mono muted">{`${fmt.ist(m.at)} IST`}</span>
                </div>
                <div className="conv-text">{m.text}</div>
                {cur && m.chips && m.chips.length ? (
                  <div className="conv-chips" role="group" aria-label="Quick replies">
                    {m.chips.map((c, k) => (
                      <Btn key={k} label={c} small cls="conv-chip" id={`${pre}chip-${wo.id}-${k}`} guard={stopD ?? (canAnswer.allowed ? null : canAnswer)} onClick={() => void send(c)} />
                    ))}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="conv-compose">
        <LockNote decision={canAnswer.allowed ? null : canAnswer} what="Answering this conversation" />
        <textarea
          id={`${pre}reply-${wo.id}`}
          className="input conv-input"
          rows={2}
          aria-label="Reply"
          placeholder={closed ? "This conversation is closed." : raised.length ? `Answer the question from ${stName(cat, raised[0]!.station)}` : conv.done ? "Add a note to the brief" : "Type your own answer"}
          disabled={!canAnswer.allowed || closed}
          value={text}
          onChange={(e) => {
            drafts[wo.id] = e.target.value;
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canAnswer.allowed && !closed) submit();
            }
          }}
        />
        <div className="conv-compose-foot">
          <span className="small muted">Enter sends, Shift+Enter adds a line.</span>
          <Btn label="Send" kind="primary" icon="send" small id={`${pre}send-${wo.id}`} guard={stopD ?? (canAnswer.allowed ? null : canAnswer)} disabledReason={canAnswer.allowed && !stop && closed ? "The conversation is closed" : busy ? "Sending" : null} onClick={submit} />
        </div>
      </div>
      {intake && !noFollowup ? (
        <div className={`conv-fu${fu ? " is-open" : ""}`}>
          <div className="conv-fu-head">
            <Btn label="Add a follow-up question" small kind="ghost" icon="plus" id={`${pre}fu-${wo.id}`} guard={stopD ?? (canAnswer.allowed ? null : canAnswer)} disabledReason={canAnswer.allowed && !stop ? (fu ? "Fill in the question below" : used >= FU_MAX ? `This conversation already has ${FU_MAX} follow-up questions` : null) : null} onClick={() => setFu({ text: "", chips: "" })} />
            {used ? <span className="small muted">{`${used} of ${FU_MAX} follow-ups used`}</span> : null}
          </div>
          {fu ? (
            <div className="conv-fu-card">
              <Field label="Question" htmlFor={`${pre}fu-text-${wo.id}`}>
                <textarea id={`${pre}fu-text-${wo.id}`} className="input" rows={2} aria-label="Follow-up question" value={fu.text} onChange={(e) => setFu({ ...fu, text: e.target.value })} />
              </Field>
              <Field label="Suggested answers" htmlFor={`${pre}fu-chips-${wo.id}`}>
                <input id={`${pre}fu-chips-${wo.id}`} className="input" aria-label="Suggested answers" placeholder="Up to three, separated by ;" value={fu.chips} onChange={(e) => setFu({ ...fu, chips: e.target.value })} />
              </Field>
              <div className="conv-fu-act">
                <Btn label="Discard" small kind="ghost" id={`${pre}fu-discard-${wo.id}`} onClick={() => setFu(null)} />
                <Btn label="Ask this" small kind="primary" icon="send" id={`${pre}fu-ask-${wo.id}`} guard={stopD ?? (canAnswer.allowed ? null : canAnswer)} onClick={() => void addFollowup()} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {intake ? (
        <div className="conv-actions">
          <div className="conv-gate">
            <GateDiamond cat={cat} gateId="G0G1" state={wo.gates.G0G1?.status === "waiting" ? "waiting" : "clear"} count={1} size="sm" />
            <span className="small">{conv.done ? "Brief is complete. Confirming passes G0+G1 and starts the route." : `${openQs} question${openQs === 1 ? "" : "s"} left before the brief can be confirmed.`}</span>
          </div>
          {noActions ? (
            <span className="muted small">Confirm or decline from the traveler header.</span>
          ) : (
            <div className="conv-act-btns">
              <Btn label="Raise a question" small icon="human" id={`${pre}raise-${wo.id}`} guard={stopD ?? decOf(wo, "park")} onClick={raiseQ} />
              <Btn label="Decline" kind="danger" small icon="x" id={`${pre}decline-${wo.id}`} guard={stopD ?? declineD} onClick={decline} />
              <Btn label="Confirm brief" kind="primary" small icon="check" id={`${pre}confirm-${wo.id}`} guard={stopD ?? confirmD} disabledReason={confirmD.allowed && !stop ? (!conv.done ? `Answer the ${openQs} open question${openQs === 1 ? "" : "s"} first` : null) : null} onClick={() => void confirm()} />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Opens the Conversations screen on a work order. */
export function useOpenConversation(): (woId: string, project: string) => void {
  return (woId, project) => {
    setProject(project);
    updatePrefs({ openConversation: woId });
    navigate("conversations");
  };
}
