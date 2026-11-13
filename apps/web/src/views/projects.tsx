import { ViewHead, Empty } from "../ui/primitives";

/** Placeholder: this screen is ported from legacy/js/views/projects.js in a later wave. */
export default function ProjectsView() {
  return (
    <div className="view">
      <ViewHead kicker="Projects" title="Projects" />
      <Empty title="Projects" text="Ported in a later wave" />
    </div>
  );
}
