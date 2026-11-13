import { ViewHead, Empty } from "../ui/primitives";

/** Placeholder: this screen is ported from legacy/js/views/floor.js in a later wave. */
export default function FloorView() {
  return (
    <div className="view">
      <ViewHead kicker="Floor" title="Floor" />
      <Empty title="Floor" text="Ported in a later wave" />
    </div>
  );
}
