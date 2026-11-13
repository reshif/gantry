import { ViewHead, Empty } from "../ui/primitives";

/** Placeholder: this screen is ported from legacy/js/views/mcp.js in a later wave. */
export default function McpView() {
  return (
    <div className="view">
      <ViewHead kicker="MCP servers" title="MCP servers" />
      <Empty title="MCP servers" text="Ported in a later wave" />
    </div>
  );
}
