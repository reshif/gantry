/** A Project config dialog that lives in the address (`?dlg=<name>:<arg>`), so a reload or a shared link brings it back (F-15). Closing it, by any route, takes it out of the address. */
import { useEffect, type ReactNode } from "react";
import { useUI } from "../../ui/overlay-context";
import { useQueryParam } from "../projects/urlState";

export function useUrlDialog(name: string, render: (arg: string, close: () => void) => ReactNode): (arg?: string) => void {
  const ui = useUI();
  const [dlg, setDlg] = useQueryParam("dlg");
  const open = (arg = ""): void => {
    setDlg(`${name}:${arg}`);
    ui.open((close) => render(arg, () => { setDlg(null); close(); }));
  };
  useEffect(() => {
    if (dlg?.startsWith(`${name}:`)) ui.open((close) => render(dlg.slice(name.length + 1), () => { setDlg(null); close(); }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return open;
}
