/**
 * Changes (#changes/WO-x): the files, diff previews and commits of one work order, with its plan and the Builder's guardrail.
 * The content is the same Changes section the work order page shows; this page gives it the whole width.
 */
import { navigate, useHash } from "../lib/router";
import { Btn, ViewHead } from "../ui/primitives";
import { Loading } from "../ui/async";
import { Picker } from "./record/Picker";
import { Changes } from "./record/sections2";
import { useRecordData } from "./record/data";

export default function ChangesView() {
  const hash = useHash();
  const id = (hash.param || "").toUpperCase();
  const d = useRecordData(id || null);
  if (!id) return <Picker />;
  if (d.loading) return <div className="view rec-view"><Loading id="chg-loading" label="the changes" /></div>;
  if (d.error || !d.wo || !d.rec || !d.project || !d.cat) {
    const status = (d.error as { status?: number } | null)?.status;
    return <Picker note={status === 403 || status === 404 ? `${id} was not found, or it belongs to a project outside your access. Pick a work order you can see.` : `Could not load the changes of ${id}.`} />;
  }
  const { wo, rec, project, cat } = d;
  return (
    <div className="view rec-view dz">
      <ViewHead
        title={`Changes: ${wo.title}`}
        sub={`Files, diff previews and commits for ${wo.id}.`}
        actions={<Btn label={`Back to ${wo.id}`} icon="back" id="chg-back" onClick={() => navigate("record", wo.id, wo.project)} />}
      />
      <Changes c={{ wo, rec, project, cat, pre: "chg-", compact: false, page: true }} />
    </div>
  );
}
