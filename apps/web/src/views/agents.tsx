import { ViewHead, Empty } from "../ui/primitives";

/** Placeholder: this screen is ported from legacy/js/views/agents.js in a later wave. */
export default function AgentsView() {
  return (
    <div className="view">
      <ViewHead kicker="Agents" title="Agents" />
      <Empty title="Agents" text="Ported in a later wave" />
    </div>
  );
}
