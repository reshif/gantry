import { navigate } from "../../lib/router";
import { setProject } from "../../lib/prefs";
import { canSeeRoute } from "../../lib/routes";
import { useMe } from "../../api/queries";
import { Icon } from "../../ui/Icon";
import { useOpenRecordRoute } from "../record/nav";
import type { Cited } from "./types";

/** Clickable chip for an entity an answer mentions (legacy G.entityChip): a work order opens its record, a project its floor, a repo its onboarding, a person or agent their screen. */
export function EntityChip({ e }: { e: Cited }) {
  const me = useMe();
  const openRecord = useOpenRecordRoute();
  const icon = ({ wo: "page", project: "project", repo: "branch", agent: "agent", gate: "gate", person: "people" } as Record<string, string>)[e.type] ?? "dots";
  const link = (label: string, go: () => void) => (
    <a className={`chip entity-chip entity-${e.type}`} href={`#${e.type === "wo" ? "record" : e.type === "person" ? "people" : "floor"}`} data-entity={`${e.type}:${e.id}`} onClick={(ev) => { ev.preventDefault(); go(); }}>
      <Icon name={icon} /><span>{label}</span>
    </a>
  );
  const plain = (label: string) => <span className="chip entity-chip is-plain" data-entity={`${e.type}:${e.id}`}><Icon name={icon} /><span>{label}</span></span>;
  if (e.type === "wo") return link(e.label && e.label !== e.id ? `${e.id} ${e.label}` : e.id, () => openRecord(e.id, e.project ?? null));
  if (e.type === "project") return link(e.label ?? e.id, () => { setProject(e.id); navigate("floor"); });
  if (e.type === "repo") return link(e.label ?? e.id, () => { if (e.project) setProject(e.project); navigate("onboarding"); });
  if (e.type === "person") return canSeeRoute("people", me) ? link(e.label ?? e.id, () => navigate("people", e.id)) : plain(e.label ?? e.id);
  if (e.type === "agent") return canSeeRoute("agents", me) ? link(e.label ?? e.id, () => navigate("agents", e.id)) : plain(e.label ?? e.id);
  return plain(e.label ?? e.id);
}
