import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { setProject } from "../../lib/prefs";

/** Opens the record screen of a work order (legacy G.openRecord); closes the traveler drawer first when asked. */
export function useOpenRecordRoute(): (woId: string, project?: string | null, closeDrawer?: boolean) => void {
  const ui = useUI();
  return (woId, project, closeDrawer) => {
    if (closeDrawer && ui.drawer.isOpen()) ui.drawer.close();
    if (project) setProject(project);
    navigate("record", woId);
  };
}
