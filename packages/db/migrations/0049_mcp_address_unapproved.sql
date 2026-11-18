-- An MCP server whose address or transport changed is no longer the server that was approved (spec 12.4). This mark stays until a
-- Factory Admin discovers and approves its tools again: switching the server off and on does not clear it.
alter table mcp_servers add column address_unapproved boolean not null default false;
