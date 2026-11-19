import { useQuery } from "@tanstack/react-query";
import { ApiError, api, get, post } from "../api/client";
import { invalidateSlices, qk } from "../api/keys";
import { useCommand } from "../lib/useCommand";
import { Icon } from "../ui/Icon";
import { Btn } from "../ui/primitives";

/** An allow-list recovery sign-in waiting for this person to say whether its address joins the allow-list. */
interface RecoveryPending { pending: boolean; address?: string; signedInAt?: number }
const useRecovery = () => useQuery({ queryKey: qk.securityRecovery(), queryFn: () => get<RecoveryPending>(api("security/recovery")), retry: false });
/** Add the address you signed in from to the allow-list (the server asks for a recent sign-in), or leave the list as it is. */
const confirmRecovery = async (add: boolean) => {
  const r = await post(api("security/recovery/confirm"), { add });
  if (r.ok) invalidateSlices(["security", "audit"]);
  return r;
};

/**
 * After a sign-in the operator's allow-list recovery let through, the server holds the address until the person decides.
 * Shown on every screen until they do: Add puts the address on the allow-list (a recent sign-in is asked for), Not now leaves the list as it was.
 */
export function RecoveryPrompt() {
  const q = useRecovery();
  const add = useCommand(() => confirmRecovery(true), { ok: "The address was added to the allow-list." });
  const decline = useCommand(() => confirmRecovery(false), { ok: "Left the allow-list as it was." });
  // an older server has no such route, and a person without a session has nothing to decide
  if (q.isError && q.error instanceof ApiError && [401, 403, 404].includes(q.error.status)) return null;
  if (q.isError) {
    return (
      <div className="banner is-halt" role="alert" id="recovery-failed">
        <Icon name="alert" />
        <div>Could not check whether a sign-in from outside the allow-list is waiting for your decision.</div>
        <Btn label="Try again" small icon="refresh" id="recovery-retry" onClick={() => void q.refetch()} />
      </div>
    );
  }
  if (!q.data?.pending) return null;
  const busy = add.busy || decline.busy;
  return (
    <div className="banner is-halt recovery-prompt" role="alert" id="recovery-prompt">
      <Icon name="lock" />
      <div>
        <strong>{`You signed in from ${q.data.address ?? "an unknown address"} outside the allow-list.`}</strong>
        {" Add it?"}
        <span className="muted small">{" Adding it lets this address reach Gantry from now on. It is audited, and you will be asked to sign in again to confirm."}</span>
        {add.error ? <div className="small" role="alert" id="recovery-error">{add.error}</div> : null}
      </div>
      <Btn label="Add" kind="primary" small id="recovery-add" disabledReason={busy ? "Working on it." : null} onClick={() => void add.run()} />
      <Btn label="Not now" kind="ghost" small id="recovery-no" disabledReason={busy ? "Working on it." : null} onClick={() => void decline.run()} />
    </div>
  );
}
