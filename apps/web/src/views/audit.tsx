import { ViewHead, Empty } from "../ui/primitives";

/** Placeholder: this screen is ported from legacy/js/views/audit.js in a later wave. */
export default function AuditView() {
  return (
    <div className="view">
      <ViewHead kicker="Audit" title="Audit" />
      <Empty title="Audit" text="Ported in a later wave" />
    </div>
  );
}
