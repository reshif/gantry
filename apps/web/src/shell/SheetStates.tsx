/**
 * The shared sheet states the prototype draws (js/shell.js): no access, sheet not found, and the read-only viewer banner.
 * Each is a page header plus one panel holding a state block, so every sheet fails in the same shape.
 */
import type { Me } from "../api/types";
import { useCanMany } from "../api/can";
import { Empty, Panel, ViewHead } from "../ui/primitives";
import { Icon } from "../ui/Icon";

/** "No access to this sheet": a role that cannot open the page, with the way back. */
export function NoAccessSheet({ title, roles }: { title: string; roles: string }) {
  return (
    <div className="view">
      <ViewHead title={title} />
      <Panel>
        <Empty id="route-denied" icon="lock" title="No access to this sheet" text={`Your role (${roles}) cannot open ${title}. Ask a factory admin for access.`} action={<a className="btn" id="route-denied-home" href="#home">Back to Home</a>} />
      </Panel>
    </div>
  );
}

/** "Sheet not found": an address that is no route. */
export function SheetNotFound({ name }: { name: string }) {
  return (
    <div className="view">
      <ViewHead title="Sheet not found" sub={`There is no route called "${name}".`} />
      <Panel>
        <Empty id="route-notfound" title="Nothing drawn here" text="Check the address or pick a sheet from the navigation." action={<a className="btn primary" id="route-notfound-home" href="#home">Go home</a>} />
      </Panel>
    </div>
  );
}

/** The server's answer to "may this person change anything here?": every probe refused means a read-only viewer. */
export function useReadOnlyViewer(me: Me, projectId: string | null): boolean {
  const ctx = projectId ? { project: projectId } : {};
  const probes = useCanMany([{ action: "wo.submit", ...ctx }, { action: "project.config", ...ctx }, { action: "agent.edit" }, { action: "model.edit" }]);
  return me.person.roles.length > 0 && probes.every((p) => !p.pending && !p.allowed);
}

export function ReadOnlyBanner() {
  return (
    <div className="banner banner-readonly" id="readonly-banner" role="status">
      <Icon name="lock" />
      Read-only viewer: mutating controls are disabled.
    </div>
  );
}
