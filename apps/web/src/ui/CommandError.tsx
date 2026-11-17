import "../lib/data.css";
import { Btn } from "./primitives";

/** The sticky, announced error for a failed write: `<CommandError error={save.error} onDismiss={save.reset} />`. Renders nothing without an error. */
export function CommandError({ error, onDismiss, id }: { error: string | null | undefined; onDismiss?: () => void; id?: string }) {
  if (!error) return null;
  return (
    <div className="cmd-error" role="alert" id={id}>
      <span>{error}</span>
      {onDismiss ? <Btn small kind="ghost" label="Dismiss" onClick={onDismiss} /> : null}
    </div>
  );
}
