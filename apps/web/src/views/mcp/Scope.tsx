/** The scope and access dialog of one MCP server: settings, scope, the access check and recent calls. Not linked from the prototype screens; it opens from `?view=scope&server=<id>`. */
import { useMcpCalls, useMcpServers, useAgents, useProjects } from "../../api/queries";
import { useActors } from "../../ui/actors";
import { useCatalog } from "../projects/kit";
import { useAllRepos } from "../govern/data";
import { Dialog } from "../../ui/Overlay";
import { Detail } from "./Detail";

/** The settings, scope, access check and recent calls of one server, read live so a save here never leaves the dialog holding an old version. */
export function ScopeDialog({ id, close }: { id: string; close: () => void }) {
  const servers = useMcpServers().data;
  const srv = servers?.find((m) => m.id === id);
  const calls0 = useMcpCalls({ limit: 500 }).data;
  const calls = Array.isArray(calls0) ? calls0 : calls0?.items ?? [];
  const projects = useProjects().data;
  const agents = useAgents().data;
  const cat = useCatalog();
  const { repos } = useAllRepos();
  const actor = useActors();
  if (!srv) return null;
  return (
    <Dialog title={`${srv.name}: scope and access`} kicker="MCP server" wide onClose={close} actions={[{ label: "Close" }]}
      body={<Detail srv={srv} cat={cat} projects={projects ?? []} agents={agents ?? []} repos={repos} calls={calls} actorName={(x) => actor(x).name} onRemoved={close} />} />
  );
}

