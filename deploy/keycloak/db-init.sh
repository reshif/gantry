#!/bin/sh
# One-shot (deploy/compose.prod.yml, keycloak-db-init): creates Keycloak's own role and database on the Gantry Postgres
# server, separate from Gantry's data, and keeps the role's password in step with the keycloak_db_password secret.
# Idempotent: safe on every start.
set -eu
export PGHOST="${PGHOST:-postgres}" PGUSER="${PGUSER:-gantry_owner}" PGDATABASE="${PGDATABASE:-gantry}"
PGPASSWORD="$(cat /run/secrets/db_owner_password)"; export PGPASSWORD
pw="$(cat /run/secrets/keycloak_db_password)"
psql -v ON_ERROR_STOP=1 -q -v pw="$pw" <<'SQL'
select format('create role keycloak login password %L', :'pw') where not exists (select 1 from pg_roles where rolname = 'keycloak') \gexec
select format('alter role keycloak login password %L', :'pw') \gexec
select 'create database keycloak owner keycloak' where not exists (select 1 from pg_database where datname = 'keycloak') \gexec
revoke all on database keycloak from public;
SQL
echo "keycloak database ready"
