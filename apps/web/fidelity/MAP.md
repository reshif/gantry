# Fidelity map: Blueprint prototype to real app

The prototype (`/home/reshif/Downloads/gantry-designs/design-3-blueprint`, hash routes, `js/*.js` render functions) is the
specification. Compare with `node apps/web/fidelity/compare.mjs <route>...` (prototype route name; real route from `routes.json`).
Fixtures: the prototype's own seed (`js/data.js`, already in server shapes) served through `e2e/seed-fixtures.ts` + `e2e/fixtures.ts`.
Project routes open as `#/p/payments/<id>`. "Cannot supply" = shown as closest real data or omitted.

Cross-cutting gaps (backend cannot supply): per-route drawing numbers (GNT-xxx-nn) are static presentation, build them in `ViewHead`;
"LIVE" pill = stream status (exists in `StatusCluster`); Task-success 8-week trend (`FACT.trend`) has no endpoint (use `evals/scorecards`
history if present, else omit); undo toast after approve/reject (9 s) has no server undo, omit; design-system page is a prototype-only
reference (map to `docs/ui`, no route).

## Group A: shell, home, inbox, projects, workspace, console
| Prototype | Real route | Hooks | Fixture | Cannot supply |
|---|---|---|---|---|
| shell (sidebar, topbar, project switcher, palette, notifications drawer, theme toggle) | `shell/Shell,Nav,TopBar,Palette,ProjectSwitcher` | useMe, useHome (badges), useProjects, useCan | `me`, `home`, `projects` | "READ-ONLY SHEET" brand line is persona text; plant name (`org.plant`) has no endpoint, use project/org name |
| home | `#/home` | useHome (`sections.waiting/motion/health`), useProjects, useActivity | `home.sections`, `activity` | task-success trend, "Line at a glance" per-station WIP limit sums (derive from floor reads per project) |
| inbox | `#/inbox` | useHome, useConversations | `home.approvals`, `conversations` | none |
| projects | `#/projects` | useProjects | `projects` | per-project card facts beyond metrics |
| workspace ("Agents at work") | `#/workspace` | useConversations, useWorkOrders | `conversations` | none |
| console | `#/console` | workspace composer commands | n/a | none |
| dialogs: submit work order, notifications drawer | command palette / `newWorkOrder` command | useCommand | n/a | none |

## Group B: floor, work orders, work-order pages
| Prototype | Real route | Hooks | Fixture | Cannot supply |
|---|---|---|---|---|
| floor (belt, Fit/Detail) | `#/p/:p/floor` | useFloorRead, useCatalog, useAgents | `projects/:id/floor` (gates, slots, stops) | Halt line/ticker exist as line control |
| floor (board) + station/valve/tag drawers | same, `Board.tsx`, `Drawers.tsx` | same | same | none |
| work-orders (table, filters, saved views) | `#/p/:p/work-orders` | useWorkOrders, useSavedViews | `projects/:id/work-orders` | none |
| record (work-order detail) | `#/p/:p/record/:id` | useRecord, useWorkOrder | `work-orders/:id/record` | none |
| traveler | `#/p/:p/record/:id` traveler panel (`views/traveler.tsx`) | useRecord | same | none |
| changes | `#/p/:p/changes/:id` | useChanges | `work-orders/:id/changes` (not in seed) | diff body |
| dossier | `views/dossier` (record tab) | useRecord | same | none |
| conversations | `#/p/:p/conversations` | useConversations | `conversations` | none |
| dialogs: approve, reject, step-up, replay | floor/record drawers, `ui/stepup` | useCommand | n/a | server undo |

## Group C: onboarding and project config
| Prototype | Real route | Hooks | Fixture | Cannot supply |
|---|---|---|---|---|
| onboarding | `#/p/:p/onboarding` | useRepos, useProject | `projects/:id/repos` | none |
| project-config (tabs: flow, approvers, notifications, budget, guidelines) | `#/p/:p/project-config` | useProject, useTemplates, useGuidelines | `projects/:id`, `templates`, `guidelines` | draft/conflict UI kept |
| new project wizard dialog | `openNewProject` | useCommand | `project-presets` | none |

## Group D: agents, skills, models, evals, trust, learning
| Prototype | Real route | Hooks | Fixture | Cannot supply |
|---|---|---|---|---|
| agents, agents/:id (detail drawer) | `#/agents`, param | useAgents | `agents` | none |
| skills | `#/skills` | useSkills | `skills` | none |
| models | `#/models` | useVendors, usePrices, useRouting, useBudgets | `vendors`, `routing` | prices/budgets not in seed |
| evals | `#/evals` | useEvalRuns, useScorecards, useSuites | `evals/runs`, `suites` | none |
| trust | `#/trust` | useTrustCells | `trust/cells` | none |
| learning | `#/learning` | useLearning* | not in seed | findings and proposals empty |

## Group E: connect, govern, sign-in, states
| Prototype | Real route | Hooks | Fixture | Cannot supply |
|---|---|---|---|---|
| integrations | `#/integrations` | useIntegrations, useIntegrationTypes | `integrations`, `integration-types` | none |
| notifications | `#/notifications` | useDeliveries | `deliveries` | none |
| mcp | `#/mcp` | useMcpServers, useMcpCalls | `mcp/servers`, `mcp/calls` | none |
| api | `#/api` | useTriggers, useApiKeys, useApiRequests | `triggers`, `api-keys`, `api-requests` | none |
| people, workload | `#/people`, `#/workload` (+ `#/person/:id`) | usePeople, useTeams, useWorkload | `people`, `teams` | workload not in seed |
| access | `#/access` | useAccessMatrix | `access/matrix` | none |
| security | `#/security` | useSecurity, useSessions, useSignins | `security`, `sessions`, `signins` | none |
| audit | `#/audit` | useAudit | `audit` | none |
| system ("System health") | `#/system` | system queries | not in seed | none |
| signin | `shell/SignIn` (MFA screen kept) | session | `/api/v1/me` 401 | none |
| states: empty, loading, error, no-access, 404 | `ui/async`, `RouteSkeleton`, error boundaries | n/a | overrides | none |


> REQUIRED: also read apps/web/fidelity/KEEP.md. Every working feature listed there must survive the rebuild of its screen, styled in the prototype language.
