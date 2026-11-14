-- MCP registry (spec 12.4): transport, protocol revision, auth mode, health and data sensitivity per server; class scope; the suggested class a server
-- hinted for each tool next to the admin-set class, and the new definition hash a rediscovery found awaiting re-approval.
alter table mcp_servers
  add column transport text not null default 'http' check (transport in ('http','sse')),
  add column protocol_revision text not null default '',
  add column auth_mode text not null default 'none' check (auth_mode in ('none','bearer','header')),
  add column auth_header text,
  add column sensitivity text not null default 'internal' check (sensitivity in ('public','internal','confidential','restricted')),
  add column health text not null default 'unknown',
  add column health_detail text,
  add column health_at timestamptz,
  add column discovered_at timestamptz;

alter table mcp_tools
  add column hint text,
  add column pending_hash text;

alter table mcp_scopes add column classes jsonb not null default '"all"';
create unique index mcp_scopes_server_idx on mcp_scopes (org_id, server_id);
