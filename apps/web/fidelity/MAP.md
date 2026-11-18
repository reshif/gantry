# Fidelity map: Control Room prototype to the real app

The prototype (`/home/reshif/Downloads/gantry-designs/design-1-control-room`) is the specification. Each row says which real route
shows the screen, which hooks feed it, which fixture data it needs (`apps/web/e2e/rich.ts`, installed by `compare.mjs`), and what the
backend cannot supply. Real hashes: factory routes `#home`, project routes `#/p/<project>/<route>`.
Status: **built** = rebuilt to the prototype and compared in `fidelity/`; **todo** = mapped, not yet rebuilt in this run.
Compare: `node apps/web/fidelity/compare.mjs <prototype-route> [...]` (`all` runs every mapped route).

## Group A: shell, home, inbox, projects, workspace, console
| Prototype | Real route | Hooks | Fixture data | Backend gaps | Status |
|---|---|---|---|---|---|
| shell: top bar, rail, status bar | `shell/*` (all routes) | `useMe`, `useNavBadges`, `useRouteAccess`, `useHome`, `useConnection`, prefs theme | me with 8 projects, home badges | no "All projects" scope (a project is always chosen); status bar has no throughput or workers figure; Conversations, Console and Reference/Design system are not nav items (route flags `nav:false`, no design-system route) | built |
| `home` | `#home` | `useHome`, `useProjects` (metrics), `useCatalog`, `useActivity`, `useActors`, `useCan`, `useOpenTraveler` | home sections (attention, waiting, motion, health), 8 projects with metrics, 40 events | no per-hour throughput (derived from `wo.enter` events), no median cycle time, no "oldest blocked"; spend is month to date, not today | built |
| `inbox` | `#inbox` | `useHome`, approvals mutations | home approvals/conversations | prototype tabs (type chips) have no server-side type filter | todo |
| `workspace` | `#workspace` | `useConversations`, `useWorkOrders` | conversations | prototype lists agent runs; backend has conversations and records | todo |
| `console` | `#console` | console commands | none | real console proposes actions through the API | todo |
| `conversations` | `#/p/payments/conversations` | `useConversations` | conversations | none | todo |
| `projects` | `#projects` | `useProjects` | 8 projects with metrics | none | todo |
| drawers: notifications, user menu, theme menu, project switcher, palette, stop dialog | shell (`ui.menu`, `ui.popover`, `PaletteDialog`, `StopDialogs`) | as shell | none | persona switcher is demo-only | partly (top bar) |

## Group B: floor, work orders, detail pages
| Prototype | Real route | Hooks | Fixture data | Backend gaps | Status |
|---|---|---|---|---|---|
| `floor` (belt, KPIs, ticker, filters, gates card, tight card) | `#/p/payments/floor` | `useFloorState` (`/projects/{id}/floor`), `useCatalog`, `useActivity`, `useDrawers`, `useOpenTraveler`, `useCan` | floor with 34 live work orders at every station, 5 gates waiting, blocked and failed work, 4 shipped | capacity exists only as project flow `wip` per station (the belt uses it for bays; uncapped stations follow their work, max 4); no per-hour KPI (shows Shipped 24h); filters are local state, not in the URL | built |
| floor drawers: token, station, gate, pile | `useDrawers().station/gate`, traveler drawer | as floor | as floor | none | wired, not restyled |
| `work-orders` | `#/p/payments/work-orders` | `useWorkOrders` | work orders list | none | todo |
| `record` | `#/p/payments/record/WO-1004[/tab]` (tabs overview, journey, gates, attempts, conversation, costs, events) | `useRecordData`, `useWoSession` | record for WO-1004 | edit title, priority, owner and description have no endpoint; tokens are not split into input, output, cached; no request-changes decision (it rejects with a reason) | built |
| `dossier` | `#/p/payments/dossier/WO-1004[/tab]` (summary, criteria, brief, checks, audit) | `useRecordData`, `useAudit` | record, audit | review findings and the plan are not recorded; export is the JSON record bundle, not PDF | built |
| `traveler` | `#/p/payments/traveler/WO-1004` (the drawer `?traveler=` stays on the floor) | `useRecordData` | work order | none | built |
| `changes` | `#/p/payments/changes/WO-1004[/file]` | `useChangesRead`, `useRecordData` | diff | line comments have no endpoint | built |

## Group C: onboarding and project config
| Prototype | Real route | Hooks | Fixture data | Backend gaps | Status |
|---|---|---|---|---|---|
| `onboarding` | `#/p/payments/onboarding` | `useRepos`, onboarding session reads | repos at stages | none | todo |
| `project-config` (+ `/id`) | `#/p/payments/project-config` | `useProject`, `useRoutes`, flow editor | project | project switch is by the top bar, not the URL param | todo |

## Group D: agents, skills, models, evals, trust, learning
| Prototype | Real route | Hooks | Fixture data | Backend gaps | Status |
|---|---|---|---|---|---|
| `agents` (+ `/ag-build`) | `#agents` | `useAgents`, `useAgentEffective` | 9 agents | none | todo |
| `skills` | `#skills` | `useSkills` | skills | none | todo |
| `models` | `#models` | `useVendors`, `usePrices`, `useRouting`, `useBudgets` | vendors, routing | factory roles only | todo |
| `evals` | `#evals` | `useScorecards`, `useSuites`, `useAllSuiteRuns` | scorecards (the old port crashed on an empty list) | none | todo |
| `trust` | `#trust` | `useTrustCells` | trust cells | none | todo |
| `learning` | `#learning` | `useLearningFindings`, `useLearningProposals` | findings | none | todo |

## Group E: connect, govern, sign-in, states
| Prototype | Real route | Hooks | Fixture data | Backend gaps | Status |
|---|---|---|---|---|---|
| `integrations`, `mcp`, `api`, `notifications` | `#integrations`, `#mcp`, `#api`, `#notifications` | `useIntegrations`, `useMcpServers`, `useApiKeys`, `useTriggers`, `useDeliveries` | lists | none | todo |
| `people` (+ `/id`), `workload`, `access`, `security`, `audit`, `system` | `#people`, `#person/<id>`, `#workload`, `#access`, `#security`, `#audit`, `#system` | `usePeople`, `useWorkload`, `useAccessMatrix`, `useSecurity`, `useAudit`, system reads | lists | none | todo |
| `signin` | sign-in shell (`/` signed out, MFA step kept) | `useMeState` | persona null | demo accounts only when configured | todo |
| `design-system` | `#design-system` | none | none | none | built |
| states `?state=loading|empty|error|forbidden|conflict` | `<Async>` states, `Empty`, `DraftConflict` | all | per-test overrides | none | todo |


> REQUIRED: also read apps/web/fidelity/KEEP.md. Every working feature listed there must survive the rebuild of its screen, styled in the prototype language.
