import { ViewHead, Empty } from "../ui/primitives";

/** Placeholder: this screen is ported from legacy/js/views/workload.js in a later wave. */
export default function WorkloadView() {
  return (
    <div className="view">
      <ViewHead kicker="Workload" title="Workload" />
      <Empty title="Workload" text="Ported in a later wave" />
    </div>
  );
}
