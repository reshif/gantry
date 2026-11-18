/**
 * Traveler (#/p/<project>/traveler/WO-x): the prototype's printable page that follows a work order down the line. The drawer
 * version (Journey, Documents, Activity) stays reachable from the floor; this is the page with Back to record and Print.
 */
import { hashFor, useHash } from "../lib/router";
import { Btn } from "../ui/primitives";
import { CrIcon, Page } from "../ui/cr";
import { Loading } from "../ui/async";
import { Picker } from "./record/Picker";
import { useRecordData } from "./record/data";
import { Sheet } from "./traveler/Sheet";

export default function TravelerPage() {
  const id = (useHash().param ?? "").toUpperCase();
  const d = useRecordData(id || null);
  if (!id) return <Picker />;
  if (d.loading) return <div className="view rec-view"><Loading id="trv-page-loading" label="the traveler" /></div>;
  if (d.error || !d.wo || !d.project || !d.cat) return <Picker note={`${id} was not found, or it belongs to a project outside your access. Pick a work order you can see.`} />;
  const { wo, project, cat } = d;
  return (
    <Page
      eyebrow={`Work order · ${wo.id}`}
      title="Traveler"
      sub="The printable record that follows the work order down the line."
      acts={
        <>
          <a className="btn" id="trv-back" href={hashFor("record", wo.id, wo.project)}>Back to record</a>
          <Btn label="Print" kind="primary" id="trv-print" onClick={() => window.print()}><CrIcon name="dl" /></Btn>
        </>
      }
    >
      <Sheet wo={wo} cat={cat} project={project} bare />
    </Page>
  );
}
