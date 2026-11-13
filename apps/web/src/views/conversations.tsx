import { ViewHead, Empty } from "../ui/primitives";

/** Placeholder: this screen is ported from legacy/js/views/conversations.js in a later wave. */
export default function ConversationsView() {
  return (
    <div className="view">
      <ViewHead kicker="Conversations" title="Conversations" />
      <Empty title="Conversations" text="Ported in a later wave" />
    </div>
  );
}
