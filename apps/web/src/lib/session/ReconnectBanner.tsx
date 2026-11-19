import "./reconnect.css";

/** Non-blocking notice when /me could not be refreshed: the app stays up on the last known session. */
export function ReconnectBanner({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div className="reconnect-banner" role="alert" id="reconnect-banner">
      <span>Can't reach Gantry right now. You're seeing the last information we had.</span>
      <button type="button" className="btn btn-sm" onClick={onRetry} disabled={retrying}>
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
