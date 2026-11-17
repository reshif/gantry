/** The whole lifecycle of one work order in eleven sections (legacy G.renderLifecycle): the body of #record and the traveler's Lifecycle tab (compact). */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmt, flowOf } from "@gantry/domain";
import { api, get, getText } from "../../api/client";
import { Btn, Empty } from "../../ui/primitives";
import { Loading, NotVisible, failureOf } from "../../ui/async";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { reducedMotion } from "../../lib/prefs";
import { navigate } from "../../lib/router";
import { useOpenRecordRoute } from "./nav";
import { journeyOf, stName, toRecEvent, type RecEvent, type TWo } from "../traveler/model";
import { Fold, useName } from "./bits";
import { SECTIONS, endAt, useRecordData, type RecordData, type SectionId } from "./data";
import { eventText, After, Approvals, Changes, Merge, Verification, Timeline } from "./sections2";
import { Agreement, Clarification, Request, Stations, Summary, type Ctx } from "./sections";
import type { Catalog, Project } from "@gantry/domain";

/** Fetches the record as Markdown and puts it on the clipboard; where the clipboard is unavailable the text is shown to copy by hand. */
export function useCopyMarkdown(): (woId: string) => Promise<void> {
  const ui = useUI();
  return async (woId) => {
    let md: string;
    try {
      md = await getText(api(`work-orders/${encodeURIComponent(woId)}/record.md`));
    } catch {
      ui.toast(`Could not load the record of ${woId}.`, "error");
      return;
    }
    const fallback = (why: string) => {
      let ta: HTMLTextAreaElement | null = null;
      ui.dialog({
        title: `Record ${woId} as Markdown`,
        kicker: "Record · copy",
        wide: true,
        sub: `${why} Select the text below and copy it with your keyboard.`,
        body: <textarea id="rec-md-text" className="input mono rec-md-text" rows={18} readOnly aria-label="Record as Markdown" defaultValue={md} ref={(el) => { ta = el; setTimeout(() => { el?.focus(); el?.select(); }, 40); }} />,
        actions: [{ label: "Select all", id: "rec-md-select", onClick: () => { ta?.focus(); ta?.select(); } }, { label: "Close", kind: "primary", id: "rec-md-close" }],
      });
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(md);
        ui.toast(`Copied ${woId} as Markdown (${md.split("\n").length} lines).`, "ok");
      } else fallback("The clipboard is not available in this frame.");
    } catch {
      fallback("The clipboard is not available in this frame.");
    }
  };
}

/* ------------------------------------------------------------------ scrubber */
export function Scrubber({ c, events, pre }: { c: Ctx; events: RecEvent[]; pre: string }) {
  const { wo, cat, project } = c;
  const name = useName();
  const [idx, setIdx] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const n = events.length;
  const i = idx == null || idx >= n ? n - 1 : idx;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);
  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => {
      setIdx((x) => {
        const nx = (x == null ? 0 : x) + 1;
        if (nx >= n - 1) setPlaying(false);
        return Math.min(nx, n - 1);
      });
    }, reducedMotion() ? 1200 : 700);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, n]);
  const e = events[i];
  const t = e?.at ?? 0;
  useEffect(() => {
    // dim the station visits that had not started yet at the chosen time
    const root = document.querySelector(".rec-main, .lc") ?? document;
    root.querySelectorAll<HTMLElement>(".rec-visit[data-at]").forEach((el) => el.classList.toggle("is-future", Number(el.getAttribute("data-at")) > t));
  }, [t, wo.history.length]);
  if (!n || !e) return null;
  const live = i === n - 1;
  const set = (k: number) => setIdx(Math.max(0, Math.min(n - 1, k)));
  const vs = wo.history.filter((h) => h.startedAt <= t);
  const seen = vs.map((h) => h.station);
  const last = vs[vs.length - 1];
  const cur = last && (!last.endedAt || last.endedAt > t || wo.state !== "done") ? last.station : null;
  const span = events[n - 1]!.at - events[0]!.at || 1;
  const stations = flowOf(cat, project).stations.filter((s) => wo.route.includes(s.id) || seen.includes(s.id));
  const text = eventText(e, c, name);
  return (
    <div className="rec-scrub" id={`${pre}scrub`}>
      <div className="rec-scrub-top">
        <div className="rec-scrub-btns">
          <Btn label="" small icon="back" aria="Previous event" id={`${pre}scrub-prev`} disabledReason={i === 0 ? "This is the first event" : null} onClick={() => set(i - 1)} />
          <Btn label={playing ? "Pause" : "Play"} small icon={playing ? "pause" : "play"} id={`${pre}scrub-play`} onClick={() => { if (!playing && i >= n - 1) setIdx(0); setPlaying(!playing); }} />
          <Btn label="" small icon="chevron" aria="Next event" id={`${pre}scrub-next`} disabledReason={live ? "This is the latest event" : null} onClick={() => set(i + 1)} />
          {live ? null : <Btn label="Latest" small kind="ghost" id={`${pre}scrub-live`} onClick={() => { setPlaying(false); setIdx(n - 1); }} />}
        </div>
        <div className="rec-scrub-read" aria-live="polite">
          <span className="mono rec-scrub-n">{`${i + 1}/${n}`}</span>
          <span className="mono muted">{fmt.stamp(t)}</span>
          <span className="rec-scrub-ev">{text}</span>
        </div>
      </div>
      <div className="rec-scrub-track">
        <div className="rec-scrub-marks" aria-hidden="true">
          {events.map((x, k) => (
            <span key={k} className={`rec-mark rec-mark-${x.type.replace(".", "-")}${k === i ? " is-on" : ""}`} style={{ left: `${(((x.at - events[0]!.at) / span) * 100).toFixed(2)}%` }} title={eventText(x, c, name)} />
          ))}
        </div>
        <input type="range" id={`${pre}scrub-range`} className="rec-scrub-range" min={0} max={n - 1} step={1} value={i} aria-label="Journey position" aria-valuetext={`Step ${i + 1} of ${n}: ${text}`} onChange={(ev) => { setPlaying(false); set(Number(ev.target.value)); }} />
      </div>
      <ol className="rec-scrub-strip" aria-label="Stations reached at this point">
        {stations.map((st) => {
          const on = cur === st.id;
          const done = seen.includes(st.id);
          return (
            <li key={st.id} className={`${on ? "is-now" : done ? "is-done" : ""}${st.custom ? " is-custom" : ""}`} title={`${st.name}${on ? ": here" : done ? ": visited" : ": not yet"}`}>
              <span className="mono">{st.no}</span>
              <span className="rec-ss-n">{st.name}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ meter */
function Meter({ rec, pre, onJump }: { rec: RecordData; pre: string; onJump: (s: SectionId) => void }) {
  const cmp = rec.completeness;
  return (
    <nav className="rec-meter" aria-label={`Record sections, ${cmp.done} of ${cmp.total} with data`}>
      <div className="rec-meter-top">
        <span className="kicker">Completeness</span>
        <span className="mono rec-meter-n">{`${cmp.done}/${cmp.total}`}</span>
      </div>
      <div className="rec-meter-bar" aria-hidden="true">
        {SECTIONS.map((s) => (
          <span key={s.id} className={cmp.sections[s.id] ? "is-on" : ""} />
        ))}
      </div>
      <ol className="rec-meter-list">
        {SECTIONS.map((s, i) => {
          const on = cmp.sections[s.id];
          return (
            <li key={s.id}>
              <button type="button" className={`rec-meter-item${on ? " is-on" : ""}`} id={`${pre}jump-${s.id}`} onClick={() => onJump(s.id)}>
                <span className="rec-meter-mark" aria-hidden="true">{on ? "■" : "□"}</span>
                <span className="mono muted">{String(i + 1).padStart(2, "0")}</span>
                <span>{s.label}</span>
                <span className="sr-only">{on ? " (has data)" : " (no data yet)"}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
export { Meter };

function KillBanner({ wo }: { wo: TWo }) {
  const name = useName();
  if (wo.state !== "killed") return null;
  const k = wo.killed;
  return (
    <div className="callout callout-fail rec-killed" role="status">
      <Icon name="st-kill" />
      <div>
        <strong>Killed. </strong>
        {`${k?.reason || "No reason recorded"} · ${k ? name(k.by) : ""}, ${k ? fmt.stamp(k.at) : ""}${k && k.scope && k.scope !== "workorder" ? ` (${k.scope} kill)` : ""}.`}
      </div>
    </div>
  );
}

function sectionBody(id: SectionId, c: Ctx): ReactNode {
  switch (id) {
    case "summary": return <Summary c={c} />;
    case "request": return <Request c={c} />;
    case "clarification": return <Clarification c={c} />;
    case "agreement": return <Agreement c={c} />;
    case "stations": return <Stations c={c} />;
    case "changes": return <Changes c={c} />;
    case "verification": return <Verification c={c} />;
    case "merge": return <Merge c={c} />;
    case "approvals": return <Approvals c={c} />;
    case "after": return <After c={c} />;
    case "timeline": return <Timeline c={c} />;
  }
}

export function Sections({ c }: { c: Ctx }) {
  const { rec, pre, compact, doc } = c;
  if (doc) {
    return (
      <article className="dz-doc" aria-label="Work order document">
        {SECTIONS.map((s, i) => (
          <section key={s.id} className="dz-sec" id={`${pre}sec-${s.id}`} aria-labelledby={`${pre}sec-${s.id}-h`}>
            <details open>
              <summary>
                <h2 className="rec-sec-title" id={`${pre}sec-${s.id}-h`}>
                  <span className="dz-n mono">{String(i + 1).padStart(2, "0")}</span>
                  <span className="dz-t">{s.label}</span>
                </h2>
                {rec.completeness.sections[s.id] ? null : <span className="chip dz-meta">no data yet</span>}
                <span className="dz-chev" aria-hidden="true"><Icon name="down" /></span>
              </summary>
              <div className="dz-sbody">
                {sectionBody(s.id, c)}
                {s.id === "changes" && rec.completeness.sections.changes ? (
                  <div className="dz-actions"><Btn label="Open full review (file tree, diff, commits)" kind="primary" small icon="branch" id={`${pre}open-changes`} onClick={() => navigate("changes", c.wo.id, c.wo.project)} /></div>
                ) : null}
              </div>
            </details>
          </section>
        ))}
      </article>
    );
  }
  return (
    <>
      {SECTIONS.map((s, i) => {
        const head = (
          <span className="rec-sec-h">
            <span className="rec-sec-no mono">{String(i + 1).padStart(2, "0")}</span>
            <span className="rec-sec-t">{s.label}</span>
            {rec.completeness.sections[s.id] ? null : <span className="rec-sec-empty mono">no data yet</span>}
          </span>
        );
        if (compact && s.id !== "summary") {
          return (
            <section key={s.id} className="rec-sec is-compact" id={`${pre}sec-${s.id}`}>
              <Fold k={`${pre}fold-${s.id}`} summary={head}>
                <div className="rec-sec-body">{sectionBody(s.id, c)}</div>
              </Fold>
            </section>
          );
        }
        return (
          <section key={s.id} className={`rec-sec${compact ? " is-compact" : ""}`} id={`${pre}sec-${s.id}`} aria-labelledby={`${pre}sec-${s.id}-h`}>
            <h2 className="rec-sec-title" id={`${pre}sec-${s.id}-h`}>
              {head}
            </h2>
            <div className="rec-sec-body">{sectionBody(s.id, c)}</div>
          </section>
        );
      })}
    </>
  );
}

/** The record body of a work order: compact for the traveler tab, full for the record screen. */
export function Lifecycle({ woId, compact = false }: { woId: string; compact?: boolean }) {
  const d = useRecordData(woId);
  const copy = useCopyMarkdown();
  const openRecord = useOpenRecordRoute();
  if (d.loading) return <Loading label="the record" />;
  if (d.error || !d.wo || !d.rec || !d.project || !d.cat) {
    const f = d.error ? failureOf(d.error) : null;
    if (f?.hidden) return <NotVisible id="lc-hidden" what="this record" reason={f.msg} />;
    return <Empty title="Record unavailable" text={d.error instanceof Error ? d.error.message : "It may have been removed, or you cannot see its project."} />;
  }
  const pre = compact ? "lc-" : "rec-";
  const c: Ctx = { wo: d.wo, rec: d.rec, project: d.project, cat: d.cat as Catalog, pre, compact };
  const events = journeyOf(d.rec.events.map(toRecEvent));
  if (!compact) return (
    <div className="rec-body">
      <KillBanner wo={d.wo} />
      <Sections c={c} />
    </div>
  );
  const cmp = d.rec.completeness;
  return (
    <div className="lc lc-stub rec is-compact">
      <div className="lc-top">
        <div className="lc-meter">
          <span className="kicker">Record</span>
          <span className="mono">{`${cmp.done}/${cmp.total} sections`}</span>
          <div className="rec-meter-bar" aria-hidden="true">
            {SECTIONS.map((s) => (
              <span key={s.id} className={cmp.sections[s.id] ? "is-on" : ""} title={s.label} />
            ))}
          </div>
        </div>
        <div className="lc-btns">
          <Btn label="Copy as Markdown" small icon="copy" id={`${pre}copy-${d.wo.id}`} onClick={() => void copy(d.wo!.id)} />
          <Btn label="Open full record" small kind="primary" icon="record" id={`${pre}open-${d.wo.id}`} onClick={() => openRecord(d.wo!.id, d.wo!.project, true)} />
        </div>
      </div>
      <KillBanner wo={d.wo} />
      <Scrubber c={c} events={events} pre={pre} />
      <Sections c={c} />
    </div>
  );
}
void stName;
void endAt;
export type { Project };

interface Bundle {
  manifest: { id: string; version: number; algorithm: string; files: Array<{ name: string; sha256: string; bytes: number }> };
  files: Record<string, unknown>;
}
/** Downloads the record bundle (GET .../record/export): the record, its Markdown, events and gates, with the sha256 of each part so a copy can be checked later. */
export function useExportRecord(): (woId: string) => Promise<void> {
  const ui = useUI();
  return async (woId) => {
    try {
      const b = await get<Bundle>(api(`work-orders/${encodeURIComponent(woId)}/record/export`));
      const blob = new Blob([JSON.stringify(b, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${woId}-record.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      ui.toast(`Exported ${woId}: ${b.manifest.files.length} parts, each with its ${b.manifest.algorithm} hash.`, "ok");
    } catch {
      ui.toast(`Could not export the record of ${woId}.`, "error");
    }
  };
}
