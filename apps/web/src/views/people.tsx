import { ViewHead, Empty } from "../ui/primitives";

/** Placeholder: this screen is ported from legacy/js/views/people.js in a later wave. */
export default function PeopleView() {
  return (
    <div className="view">
      <ViewHead kicker="People & teams" title="People & teams" />
      <Empty title="People & teams" text="Ported in a later wave" />
    </div>
  );
}
