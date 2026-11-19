/**
 * "Withdraw exception": an accepted onboarding exception (a repo Ready without finishing onboarding) is taken back with a reason of at least
 * 10 characters, written to the audit. Guarded by the server's onboarding.exception decision, like marking the exception.
 */
import { useCan } from "../../api/can";
import { commands } from "../../api/commands";
import { Btn } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";

export const WITHDRAW_MIN = 10;

export function WithdrawException({ repoId, repoName, project, id }: { repoId: string; repoName: string; project: string; id: string }) {
  const ui = useUI();
  const exc = useCan("onboarding.exception", { project, repo: repoId });
  return (
    <Btn
      label="Withdraw exception" small kind="ghost" icon="shield" id={id} guard={exc}
      onClick={() => ui.reasonDialog({
        title: `Withdraw the exception on ${repoName}`, kicker: "Onboarding exception", label: "Why is the exception no longer right?", ok: "Withdraw exception", kind: "danger", min: WITHDRAW_MIN,
        sub: "The repo goes back to its real onboarding state: open gaps count again and agents stop picking up work until it is Ready. The reason is written to the audit ledger.",
        onOk: async (v) => { const x = await commands.withdrawException(repoId, v); if (x.ok) ui.toast(x.msg, "warn"); return x; },
      })}
    />
  );
}
