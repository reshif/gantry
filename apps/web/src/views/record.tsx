/**
 * Work order page (#record/WO-x, also #wo/WO-x): the whole life of one work order, in seven tabs (views/dossier/).
 * With no work order selected it shows the record picker.
 */
import { useEffect } from "react";
import { useHash } from "../lib/router";
import { useClearRouteStateOnLeave, useRouteState } from "../lib/queryState";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Picker } from "./record/Picker";
import { Dossier, tabFromParam } from "./dossier/Dossier";

export default function RecordView() {
  const hash = useHash();
  const prefs = usePrefs();
  const [rawId = "", rawTab = ""] = (hash.param || "").split("/");
  const id = (rawId || prefs.record || "").toUpperCase() || null;
  const [qTab] = useRouteState("tab", "overview");
  useClearRouteStateOnLeave(["tab"]);
  const tab = tabFromParam(rawTab || qTab);
  // the hash is the address; keep the legacy in-memory pref in step so other screens agree
  useEffect(() => {
    if (id && prefs.record !== id) updatePrefs({ record: id });
  }, [id, prefs.record]);
  if (!id) return <Picker />;
  return <Dossier id={id} tab={tab} />;
}
