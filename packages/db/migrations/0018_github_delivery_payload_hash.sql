-- Spec 5.3 replay protection for webhooks: GitHub signs the body but not the X-GitHub-Delivery header, so a captured body resent
-- under a fresh delivery id must be recognised by its payload hash.
create index if not exists inbound_deliveries_payload_idx on inbound_deliveries (org_id, source, payload_hash);
