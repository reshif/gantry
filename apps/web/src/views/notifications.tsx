import { ViewHead, Empty } from "../ui/primitives";

/** Placeholder: this screen is ported from legacy/js/views/notifications.js in a later wave. */
export default function NotificationsView() {
  return (
    <div className="view">
      <ViewHead kicker="Notifications" title="Notifications" />
      <Empty title="Notifications" text="Ported in a later wave" />
    </div>
  );
}
