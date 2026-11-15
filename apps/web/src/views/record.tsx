/**
 * Work order record (#record/WO-x): the whole lifecycle of one work order, ported from legacy/js/views/record.js.
 * With no work order selected it shows the record picker. The sections live in views/record/.
 */
import { useEffect } from "react";
import { fmt } from "@gantry/domain";
import { useMe } from "../api/queries";
import { useHash, navigate } from "../lib/router";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Btn, Empty, ViewHead } from "../ui/primitives";
import { Loading } from "../ui/async";
import { useOpenTraveler } from "../shell/useTraveler";
import { Crumbs } from "./projects/kit";
import { Picker } from "./record/Picker";
import { Meter, Scrubber, Sections, useCopyMarkdown, useExportRecord } from "./record/Lifecycle";
import { useRecordData } from "./record/data";
import { SECTIONS, srcName } from "./record/data";
import { useName } from "./record/bits";
import { bayLabel, clsName, journeyOf, stName, toRecEvent } from "./traveler/model";
import { WO_STATES } from "@gantry/domain";

export default function RecordView() {
  const hash = useHash();
  const prefs = usePrefs();
  const id = (hash.param || prefs.record || "").toUpperCase() || null;
  // the hash is the address; keep the legacy in-memory pref in step so other screens agree
  useEffect(() => {
    if (id && prefs.record !== id) updatePrefs({ record: id });
  }, [id, prefs.record]);
  if (!id) return <Picker />;
  return <One id={id} />;
}

function One({ id }: { id: string }) {
  const me = useMe();
  const d = useRecordData(id);
  const copy = useCopyMarkdown();
  const exportRec = useExportRecord();
  const openTraveler = useOpenTraveler();
  const name = useName();
  if (d.loading) return <div className="view rec-view"><Loading id="rec-loading" label="the record" /></div>;
  const status = (d.error as { status?: number } | null)?.status;
  if (d.error || !d.wo || !d.rec || !d.project || !d.cat) {
    if (status === 401) return <Picker />;
    return <Picker note={status === 403 || status === 404 ? `${id} was not found, or it belongs to a project outside your access. Pick a record you can see.` : `Could not load ${id}.`} />;
  }
  const { wo, rec, project, cat } = d;
  const c = { wo, rec, project, cat, pre: "rec-", compact: false };
  const st = cat.stations[wo.station];
  const jump = (s: string) => {
    const el = document.getElementById(`rec-sec-${s}`);
    if (!el) return;
    el.scrollIntoView({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    const hd = el.querySelector<HTMLElement>(".rec-sec-title");
    hd?.setAttribute("tabindex", "-1");
    hd?.focus({ preventScroll: true });
  };
  const events = journeyOf(rec.events.map(toRecEvent));
  void me;
  void SECTIONS;
  return (
    <div className="view rec-view">
      <Crumbs items={[{ label: project.name, href: "#work-orders" }, { label: "Records" }, { label: wo.id }]} />
      <ViewHead
        kicker="Work order record"
        title={`${wo.id} ${wo.title}`}
        sub={`${wo.repo} · ${clsName(cat, wo.cls)} · requested by ${name(wo.requestedBy)} via ${srcName(wo.source)}, ${fmt.stamp(wo.createdAt)}`}
        meta={[
          ["State", (WO_STATES as Record<string, { label: string }>)[wo.state]?.label ?? wo.state],
          ["Where", wo.state === "done" ? "Shipped" : wo.bay ? bayLabel(cat, wo.bay) : `${st?.no ?? ""} ${stName(cat, st?.id)}`.trim()],
          ["Record", `${rec.completeness.done} of ${rec.completeness.total}`],
          ["PR", wo.pr && wo.pr.number ? `#${wo.pr.number}` : "none"],
        ]}
        actions={
          <>
            <Btn label="Copy as Markdown" icon="copy" id="rec-copy" onClick={() => void copy(wo.id)} />
            <Btn label="Export" icon="ledger" id="rec-export" onClick={() => void exportRec(wo.id)} />
            <Btn label="Open traveler" icon="page" id="rec-traveler" onClick={() => openTraveler(wo.id)} />
            <Btn label="All records" kind="ghost" icon="list" id="rec-all" onClick={() => { updatePrefs({ record: null }); navigate("record"); }} />
          </>
        }
      />
      <div className="rec rec-layout">
        <aside className="rec-side">
          <Meter rec={rec} pre="rec-" onJump={jump} />
        </aside>
        <div className="rec-main">
          <div className="rec-journey">
            <div className="rec-journey-h">
              <span className="kicker">Journey</span>
              <span className="small muted">Step through this work order&apos;s own history.</span>
            </div>
            <Scrubber c={c} events={events} pre="rec-" />
          </div>
          {wo.state === "killed" ? (
            <div className="callout callout-fail rec-killed" role="status">
              <strong>Killed. </strong>
              {wo.killed ? `${wo.killed.reason || "No reason recorded"} · ${name(wo.killed.by)}, ${fmt.stamp(wo.killed.at)}.` : ""}
            </div>
          ) : null}
          <div className="rec-body">
            <Sections c={c} />
          </div>
        </div>
      </div>
    </div>
  );
}
void Empty;
