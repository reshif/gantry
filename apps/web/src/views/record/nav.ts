import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { setProject } from "../../lib/prefs";

/** Opens the record screen of a work order (legacy G.openRecord); `full` also opens the station documents and full history (?full=1); closes the traveler drawer first when asked. */
export function useOpenRecordRoute(): (woId: string, project?: string | null, closeDrawer?: boolean, full?: boolean) => void {
  const ui = useUI();
  return (woId, project, closeDrawer, full) => {
    if (closeDrawer && ui.drawer.isOpen()) ui.drawer.close();
    if (project) setProject(project);
    navigate("record", full ? `${woId}?full=1` : woId);
  };
}
