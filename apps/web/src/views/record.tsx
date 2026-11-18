/**
 * Work order page (#record/WO-x, also #wo/WO-x): the whole life of one work order, in the Document and Activity tabs (views/dossier/).
 * With no work order selected it shows the record picker.
 */
import { useEffect } from "react";
import { useHash } from "../lib/router";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Picker } from "./record/Picker";
import { splitQuery } from "./dossier/hashQuery";
import { Dossier, type DossierTab } from "./dossier/Dossier";

export default function RecordView() {
  const hash = useHash();
  const prefs = usePrefs();
  const { id: pathPart } = splitQuery(hash.param);
  const [rawId = "", rawTab = ""] = pathPart.split("/");
  const id = (rawId || prefs.record || "").toUpperCase() || null;
  const tab: DossierTab = rawTab === "activity" || rawTab === "gates" || rawTab === "runs" ? rawTab : "document";
  // the hash is the address; keep the legacy in-memory pref in step so other screens agree
  useEffect(() => {
    if (id && prefs.record !== id) updatePrefs({ record: id });
  }, [id, prefs.record]);
  if (!id) return <Picker />;
  return <Dossier id={id} tab={tab} />;
}
