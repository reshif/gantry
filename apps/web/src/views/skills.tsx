import { ViewHead, Empty } from "../ui/primitives";

/** Placeholder: this screen is ported from legacy/js/views/skills.js in a later wave. */
export default function SkillsView() {
  return (
    <div className="view">
      <ViewHead kicker="Skills" title="Skills" />
      <Empty title="Skills" text="Ported in a later wave" />
    </div>
  );
}
