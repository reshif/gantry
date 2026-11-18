/** The prototype's 404 page for an id that does not exist (an unknown agent or skill in the URL): eyebrow, title, one card, a way home. */
import { Btn } from "../ui/primitives";
import { CrEmpty, Page } from "../ui/cr";
import { navigate } from "../lib/router";

export function NotFoundPage({ what }: { what: string }) {
  return (
    <Page eyebrow="404" title="Page not found" cls="view-notfound">
      <div className="card">
        <CrEmpty icon="search" title={`There is no “${what}” page`} text="The link may be old, or the page was renamed." action={<Btn label="Go Home" kind="primary" id="nf-home" onClick={() => navigate("home")} />} />
      </div>
    </Page>
  );
}
