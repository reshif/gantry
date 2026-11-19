# Project Admin and the Govern pages: nav versus matrix (owner decision)

Status: open, not changed. This is a product decision, so no code was altered.

## Finding (QA, live merged app)

The web nav hides Access, Security and System health from `project_admin`, but the access matrix shown for `project_admin` reports `policy.view` and `integrations.view` as allowed. `integrations.view` returns vendor key masks (`secret_mask`, for example the last characters of a model vendor key), so a person who can call the API directly could read what the nav hides.

## Evidence

- Nav rules, `apps/web/src/lib/routes.ts`: `access` and `security` (perm `policy.view`) and `system` (perm `integrations.view`) use `canSee: anyRole(me, FACTORY_READ)`, and `FACTORY_READ` is factory_admin, auditor, factory_manager, security_reviewer. `integrations`, `notifications`, `api`, `people` use `[...FACTORY_READ, "project_admin"]`, so Project Admin sees Integrations, API and People but not Access, Security or System health.
- Server gates, `services/api/src/core/read-gates.ts`: `/policies|freezes|access|roles` need `policy.view`; `/integrations|integration-types|mcp|system` need `integrations.view`; `/vendors|models|routing|prices|budgets` need `models.view`. All are factory-scope rights. The server decides by the matrix, not by the nav, so the nav is only a convenience.
- Catalog, `packages/domain/src/catalog.ts`: `policy.view`, `people.view`, `agents.view`, `models.view`, `integrations.view` are `scope: "factory"`. The default matrix builds `project_admin` from `scope === "project"` actions only (`projectActions`), so by default `project_admin` does not hold them. The seeded matrix (`seed.data.ts`) gives `project_admin` only `project.view` and `audit.view` among the view rights. The reported grant therefore comes from a matrix edited on the live org, or from a factory-level role held in addition; check Access > matrix on the live org before choosing.
- What a vendor or integration response carries: a mask (`secret_mask`, `secretMask`), never the key. The mask is the last characters of a key, which is low value but not nothing, and `GET /system/health` also lists service and backup detail.

## Options

1. Matrix is the truth, nav follows it. Show Access, Security and System health to anyone whose matrix grants the view right (`canSee` from `perm`, not a fixed role list). Least surprise, one source of truth; a Project Admin granted `policy.view` sees the whole factory policy.
2. Nav is the truth, matrix follows it. Make the Read rights factory-role-only in the matrix editor (refuse granting `policy.view`, `integrations.view`, `models.view`, `people.view` to a project-level role, as `gateModeLock` does for gates). Strongest least privilege; takes away a deliberate customisation.
3. Split the rights. Keep `integrations.view` for what a Project Admin needs (their project's integrations) and add a separate factory right for key masks and system health, so Integrations stays visible but masks and health need the new right. Most precise, the most work and a migration of existing matrices.
4. Keep both, narrow the data. Leave nav and matrix alone and drop the mask from responses for callers who hold the right only through a project role. Smallest change, leaves an inconsistent screen.

## Recommendation for the owner to confirm

Option 2 for `policy.view` and `system` (factory-wide policy and health have no project-level meaning), and option 3 if Project Admins need to see their own project's integrations. Whichever is chosen, add a test that pins nav visibility to the same rule the server uses.
