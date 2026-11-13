import { ViewHead, Empty } from "../ui/primitives";

/** Placeholder: this screen is ported from legacy/js/views/console.js in a later wave. */
export default function ConsoleView() {
  return (
    <div className="view">
      <ViewHead kicker="Console" title="Console" />
      <Empty title="Console" text="Ported in a later wave" />
    </div>
  );
}
