import { Empty } from "../ui/primitives";

/**
 * Placeholder: the work order traveler is a drawer, not a route (legacy G.openTraveler, js/views/traveler.js).
 * Open it with `ui.drawer.open("traveler:" + woId, (close) => <Traveler woId={woId} onClose={close} />)`. Ported in a later wave.
 */
export default function TravelerDrawer({ woId, onClose }: { woId: string; onClose?: () => void }) {
  return (
    <div className="drawer-body">
      <div className="drawer-head">
        <h2 className="dlg-title">{woId}</h2>
        {onClose ? (
          <button type="button" className="icon-btn drawer-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        ) : null}
      </div>
      <Empty title="Traveler" text="Ported in a later wave" />
    </div>
  );
}
