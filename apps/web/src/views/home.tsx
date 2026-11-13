import { ViewHead, Empty } from "../ui/primitives";

/** Placeholder: this screen is ported from legacy/js/views/home.js in a later wave. */
export default function HomeView() {
  return (
    <div className="view">
      <ViewHead kicker="Home" title="Home" />
      <Empty title="Home" text="Ported in a later wave" />
    </div>
  );
}
