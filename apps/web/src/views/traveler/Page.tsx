/** The Traveler page (#traveler/<WO>): the printable routing sheet in a page of its own, with Back to record and Print in the header. The drawer (?traveler=) keeps the same sheet as one of its tabs. */
import { useHash, navigate } from "../../lib/router";
import { Btn } from "../../ui/primitives";
import { Page } from "../../ui/cr";
import { Loading } from "../../ui/async";
import { NotFound, splitParam, statusOf } from "../dossier/kit";
import { Picker } from "../record/Picker";
import { useRecordData } from "../record/data";
import { Sheet } from "./Sheet";

export default function TravelerPage() {
  const hash = useHash();
  const { id } = splitParam(hash.param);
  const d = useRecordData(id || null);
  if (!id) return <Picker />;
  if (d.loading) return <div className="page"><Loading id="trv-page-loading" label="the traveler" /></div>;
  if (d.error || !d.wo || !d.project || !d.cat) {
    const s = statusOf(d.error);
    return s === 403 || s === 404 || (!d.error && !d.wo) ? <NotFound id={id} /> : <Picker note={`Could not load the traveler of ${id}.`} />;
  }
  return (
    <Page
      cls="trv-page"
      eyebrow={`Work order · ${d.wo.id}`}
      title="Traveler"
      sub="The printable record that follows the work order down the line."
      acts={
        <>
          <Btn label="Back to record" id="trv-back" onClick={() => navigate("record", d.wo!.id, d.wo!.project)} />
          <Btn label="Print" kind="primary" icon="page" id="trv-print" onClick={() => window.print()} />
        </>
      }
    >
      <Sheet wo={d.wo} cat={d.cat} project={d.project} page />
    </Page>
  );
}
