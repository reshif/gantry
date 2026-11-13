import { ViewHead, Empty } from "../ui/primitives";

/** Placeholder: this screen is ported from legacy/js/views/learning.js in a later wave. */
export default function LearningView() {
  return (
    <div className="view">
      <ViewHead kicker="Learning" title="Learning" />
      <Empty title="Learning" text="Ported in a later wave" />
    </div>
  );
}
