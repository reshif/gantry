import { ViewHead, Empty } from "../ui/primitives";

/** Placeholder: this screen is ported from legacy/js/views/work-orders.js in a later wave. */
export default function WorkOrdersView() {
  return (
    <div className="view">
      <ViewHead kicker="Work orders" title="Work orders" />
      <Empty title="Work orders" text="Ported in a later wave" />
    </div>
  );
}
