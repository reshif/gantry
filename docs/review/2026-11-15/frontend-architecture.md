# Gantry web (apps/web/src) - frontend architecture audit and target framework

Scope: 42.9k lines in apps/web/src (incl. 8.0k test lines in 33 test files, 4.2k lines CSS). Method: grep/structural counts (non-test files unless stated), jscpd, typecheck, vitest, vite build. All counts exclude *.test.* unless noted. Counts are regex-based, so treat as +/-10%.

## 0. Verdict

The owner's diagnosis is right, but the cause is not copy-paste. jscpd finds only 0.28% exact clones (4 clones, 86 lines). What exists is **structural duplication**: the same ~12 UI patterns re-implemented per view with per-view CSS prefixes, per-view data hooks and per-view loading/error/confirm handling. A design system exists (ui/primitives.tsx, 327 lines, 25 exports) and is widely used for buttons/fields/panels, but it has no table, list, drawer-content, form, async-state, markdown or thread primitives, so every view builds those by hand. The data layer is solid at its core (client.ts, ops.ts, keys.ts SSE invalidation, can.ts) but views bypass it in ~20 files and nothing standardizes loading/error/mutation UX.

Health baseline (verified):
- `npm run typecheck -w @gantry/web`: clean (0 errors).
- `npm test -w @gantry/web`: 33 files, 441 tests passed. First run printed "Errors 1 error" and exit code 1 (an unhandled error outside any test, not identified); a second run did not reproduce it. P2: flaky unhandled error, find it (run `vitest run --reporter=verbose` in CI and fail on unhandled).
- `vite build`: OK in 6.5 s. Entry chunk `index-*.js` 644 kB (200 kB gzip), triggers Vite's >500 kB warning; 24 lazy view chunks 45-67 kB each; CSS 262 kB single file (not split, 4.2k source lines, ships to every view).

## 1. Duplication (with numbers)

| Pattern | Evidence | Sev |
|---|---|---|
| Hand-rolled tables | 67 `<table` in 43 files (SortTable used in 3 files only; `Table` primitive in 1 file, primitives.tsx:301). e.g. mcp/Usage.tsx:9, work-orders.tsx:231, audit.tsx:128, record/Picker.tsx:114, evals/Factory.tsx (5 tables), console/Cards.tsx (3), notifications/Other.tsx (3), project-config/misc.tsx (3). 107 `className="table/tbl..."` uses. Row-click logic (`closest("button,a,input...")` guard + tabIndex + Enter key) is copy-pasted in work-orders.tsx:231, mcp.tsx:52, record/Picker.tsx:114, audit.tsx:128 (the last has no keyboard support: a11y bug). | P1 |
| Page headers / panels | 124 raw `<h2/h3>` in 48 files vs 103 `<Panel` in 31 files and ViewHead. Mixed. | P2 |
| Loading states | ~31 ad hoc strings in 26 files: "Loading…", "Loading the work orders…", "Loading the record…", "Loading the conversation..." (three dots vs ellipsis), "Loading skills", "Loading permissions."; `<p className="muted small">`, `<div className="view ...">`; Suspense fallback is `null` (Shell.tsx:155) so lazy chunks flash blank. No skeleton anywhere. | P1 |
| Error states | 89 `useQuery` call sites but only 20 `isError`/`.error` uses. Of 20 sampled view files that call a data hook, none handle errors in: onboarding.tsx, security.tsx, trust.tsx, mcp.tsx, evals.tsx, access.tsx, projects.tsx, skills.tsx, project-config.tsx, floor/Belt.tsx, api/Triggers.tsx, trust/Ladder.tsx, learning/*. A failed read renders as empty data or a spinner forever. Where handled, copy is bespoke ("Home could not be loaded", "The ledger could not be loaded"). | P1 |
| Empty states | `<Empty>` primitive used 82x in 53 files (good), but also `className="empty empty-state"` 7x, `empty-title` 9x, `muted small` as ad hoc empty text 233x total `muted small` paragraphs. | P2 |
| Status pills/chips | 67 `className="chip..."` in 37 files plus 14 `tag`, plus per-view state-to-class maps: `mcp OUTCOME`, `rec-out-*`, `tr-pst-*`, `wo-prio-*`, `wos-wait`, `ln-sig-*`, `o-row-*`. Only `StateChip` (WO states) is shared (8 uses). `Chip` primitive (primitives.tsx:219) is a thin span, no tone prop: tone is a CSS class string the view must know (`chip-warn`, `chip-block`, `chip-accent`). | P1 |
| Drawers | One drawer host in Overlay.tsx (good) but 12 files each build their own drawer body, header, tabs and footer: onboarding/Drawer.tsx (300 lines), floor/Drawers.tsx (372), traveler/Drawer.tsx, workload/Drawer.tsx, audit/Detail.tsx, integrations/Instance.tsx. Drawer has fixed `aria-label="Details"` (Overlay.tsx:120) regardless of content. | P2 |
| Dialogs | 71 dialog openers (`ui.dialog(`/`<Dialog`) in views; form dialogs each re-implement field state, validation, busy flag, submit, error line. Confirm flows: ~87 mentions; bespoke `console/Confirm.tsx`, `shell/StopDialogs.tsx` (301), `ui/stepup.tsx`, `ui/override.tsx`, `people/TeamDialog.tsx`, `people/InviteDialog.tsx`. No `useConfirm()` primitive. | P1 |
| Forms | 216 `<input`, 44 `<textarea`, 361 `<Field` use. Local `useState` for every field: 261 `useState(` across views, ~31 `useState(false)` busy flags, 228 busy/pending/disabled references. No form hook, no dirty-tracking/savebar primitive (there is a `savebar-text` class used ad hoc), no field-level validation display convention. Mutation + toast is wrapped by `useOutcome` (views/govern/data.ts:53) but that lives under govern/ and only 39 call sites use it. | P1 |
| Tabs | `Tabs` primitive used in 18 files (good), but arrow-key handling calls `.click()` on focus (activation-follows-focus, no roving tabindex, no `aria-controls`/`tabpanel`), and active-tab state is local `useState` (onboarding/Drawer.tsx:230 even uses a module-level `tabMemory`), so tabs are not deep-linkable. | P2 |
| Markdown | One renderer, `views/console/Markdown.tsx`, imported by console.tsx and conversations/Session.tsx (a view importing from a sibling view). `useCopyMarkdown` in record/Lifecycle is export, not render. Other long text (briefs, instructions, learning drafts, skills) is plain text. Not duplicated, but misplaced: should be `ui/Markdown`. | P3 |
| Chat/thread UIs | Four separate implementations: console.tsx (357; own message model, optimistic local msgs, retry, streaming, pins), conversations/Thread.tsx (319; brief/questions thread), conversations/Session.tsx (work-order agent session), onboarding/Agent.tsx (+onboarding/Drawer). Each has its own message list markup (`msg-text`, `conv-*`, `wos-*`, `onb-*` classes), composer, scroll-to-bottom (12 scrollTop/scrollIntoView sites), avatar/name header, "thinking" state, and polling (session-api.ts refetchInterval 15 s/20 s, onboarding 15 s). | P1 |
| Filters / search | work-orders.tsx, record/Picker.tsx, audit.tsx, people OrgTree, skills, evals each own a toolbar with `q` state, Select filters, and URL-less state; saved views exist server-side (`useSavedViews`) but only some lists use them. | P2 |
| `kit.tsx` files | 17 `kit`/`testkit` files (2.5k lines): integrations, learning, floor, projects, agents, trust, api, evals, workload, mcp, onboarding, notifications, session, models. These are per-view mini design systems (shared bits within a view) and are the clearest evidence of missing shared primitives. Also each view area mixes data hooks into kit.tsx (floor/kit.tsx, projects/kit.tsx, onboarding/kit.tsx, notifications/kit.tsx contain `useQuery`). | P1 |
| CSS prefix-per-view | ~30 per-view prefixes (`fl-` 251 rules, `rec-` 218, `hm-` 174, `tr-` 99, `int-` 97, `pcf-` 95 ...). Equivalent things get different names (`.member`, `.wos-row`, `.hm-row`, `.rec-row`, `.int-row`). | P1 |
| Role checks in UI | See section 4: 132 `useCan(` plus 37 direct role checks. | P1 |

Biggest single structural smell: 1,316 hard-coded `id="..."` attributes in non-test TSX (e.g. `id="ppl-accept"`) and 738 `querySelector/getElementById` in tests. Tests are coupled to legacy DOM ids ported from the vanilla prototype ("kept for fidelity and tests", primitives.tsx:243). This is the main constraint on migration (section 8).

## 2. Design system as it stands

What exists (ui/primitives.tsx): `Btn` (kind/small/guard/disabledReason), `IconBtn`, `Toggle`, `Select`, `Field`, `LockNote`, `Tabs`, `Segmented`, `StateChip`, `Chip`, `Mono`, `Avatar`, `Who`, `Empty`, `ViewHead`, `Panel`, `Meter`, `Table` (class wrapper only), `useCopy`, `useFieldId`, `guardProps`. Also ui/Overlay.tsx (477: Dialog with focus trap + restore focus, one drawer, popover/menu, toast), ui/SortTable.tsx (sort/page/responsive cards), ui/charts.tsx (string-built SVG via dangerouslySetInnerHTML), ui/Icon.tsx, ui/Tip.tsx, ui/stepup.tsx, ui/override.tsx.

What is good: tokens.css (118 lines) has type scale (`--t-*`), spacing (`--s1..s6`), radii, neutrals, semantic state colors each with soft variants, and proper dark mode (system + forced via `data-theme`, tokens.css:54,88). `Btn` has a built-in "guard" concept (permission decision -> disabled with reason). `Dialog` has role=dialog, aria-modal, labelledby, focus trap, focus restore.

What is missing / bypassed:
- No `Input`, `Textarea`, `Checkbox`, `Radio` primitives: 216 raw `<input>`, 44 `<textarea>`, 5 raw `<select>` (5 files) bypass `Select`. 120 raw `<button>` in 60 files (e.g. console.tsx:330 icon button with hand-written `icon-btn icon-btn-sm`) vs 385 `<Btn>`.
- No `Badge/Pill` with tone, `DataTable` adoption, `Drawer` layout, `ConfirmDialog`, `Form`, `AsyncBoundary`/`Skeleton`, `Toolbar`, `KeyValue/DefinitionList`, `Markdown`, `Thread/Message/Composer`, `PageTemplate`.
- Spacing: tokens exist (`--s1..s6`, 480 `var(--s*)` uses) but 3,510 raw `px` literals in view CSS: the scale is not enforced. 5 raw hex outside tokens.css (base.css 1, shared.css 2, onboarding.css 2). Zero hex in TSX (good). 32 inline `style={{}}` in 24 files, mostly legitimate CSS-variable passing (`--o`, `--cols`) and progress widths, so low priority.
- Responsiveness: ~65 `@media` blocks spread across all css files, each view does its own breakpoints (shared.css 10, home.css 9, base.css 8); SortTable has a 640 px card mode (nice) but hand-rolled tables do not; `members` scroll-into-view hack at `window.innerWidth < 1100` (people.tsx:84). No container/breakpoint tokens.
- CSS is one 262 kB bundle: all 30 view stylesheets load for everyone.
- Overlay: a single drawer (good) but dialogs open via imperative `ui.dialog({body, actions})` with JSX captured in a closure; state inside such closures is hard to keep reactive (cause of many `useState` + manual rerender workarounds). Menu/popover role is `dialog` rather than `menu`, no arrow-key navigation.

## 3. Data layer

Strengths: single `client.ts` (CSRF, Idempotency-Key, If-Match, refusal-as-value `ApiResult`), `ops.ts` (338 lines, typed command per endpoint, auto-invalidation via `run()`), `keys.ts` with slice names and `DEPENDENTS` map matched to server SSE `change` events (stream.ts), full-invalidate on SSE reconnect (stream.ts:66), `can.ts` batched/cached decision cache cleared on relevant slice changes. `makeQueryClient` skips retry on 4xx. This is a good core.

Findings:
- P1 Data hooks scattered. `api/queries.ts` has the canonical hooks, but 20 files declare their own `useQuery`: views/govern/data.ts, floor/kit.tsx, projects/kit.tsx, projects/wizard.tsx, work-orders.tsx, record/data.ts, record/Picker.tsx, audit/data.ts, console/api.ts, console/ModelPicker.tsx, conversations/session-api.ts, onboarding/session-api.ts, onboarding/kit.tsx, notifications/kit.tsx, people.tsx (3 inline queries), traveler/Approvers.tsx, traveler/model.ts, shell/StopDialogs.tsx. 24 `queryKey: [` string-literal keys in 13 files, bypassing `qk`.
- P1 Key collisions with different shapes. `["teams"]` is used by govern/data.ts:14 (`Team[]`) and projects/kit.tsx:312 (`TeamRow[]`) with the same key but different generic types: one cached value serves both, so types lie and a cache fill from one query feeds the other. `["security"]` is `qk.security()` (`SecuritySettings`) and people.tsx:44 (`{domains: string[]}`) with `retry:false`; same issue. Fix with one hook per key.
- P1 Console uses its own key namespace `ck` (`["console", ...]`) which is not in `DEPENDENTS`, so SSE never refreshes it; console.tsx invalidates by hand (lines 147, 205, 209, 242, 330) and is the only place that does manual `qc.invalidateQueries` (5 of 8 total call sites).
- P1 No `useMutation` anywhere (0). Mutations are `await ops.x(); outcome(r)` in handlers. Consequences: no uniform `isPending` (hence 31 `useState(false)` busy flags and 228 busy/pending references), double-submit protection is per-handler, no unified error mapping (403 vs 409 stale vs 422 validation are each shown as a toast by `useOutcome`; field-level 422 errors cannot be attached to fields), no optimistic updates (0 `onMutate`/`setQueryData`), invalidation is whole-slice (`invalidateQueries({queryKey:[slice]})`) so every save refetches the list and all dependents. Acceptable for correctness, poor for perceived speed. 409/If-Match stale conflicts are handled per view (`ifMatchOf`, `versionOf` in govern/data.ts; govern only).
- P2 Poll and live mix. SSE exists app-wide but 3 places poll (15 s, 20 s, 15 s: conversations/session-api.ts:63,65; onboarding/session-api.ts:37), plus `setInterval` re-render timers in 7 files (floor.tsx:30,152, home/sections.tsx:23, conversations/Brief.tsx:34, record/Lifecycle.tsx:62, StatusCluster.tsx:20). The session endpoints should be SSE slices (`sessions`/`onboarding`) not polls. Console streaming (fetch + stream, `Date.now()` heuristics matching local to server messages by text and a 10 s window, console.tsx:120-124) is fragile: dedupe by text/time rather than client message id.
- P2 `as unknown as` x56 in 41 files, 228 `as X` casts in 99 files, 1 explicit `any`. The casts mostly paper over `ApiResult<T>` not carrying the response body type: `(r as unknown as {skill?: SkillRow}).skill` (skills.tsx:288, integrations/AddDialog.tsx:68,96, people/InviteDialog.tsx:45) and `useAgents().data as unknown as AgentRow[]` (skills.tsx:305) - the API types and view types diverge. Fix by making ops return `ApiResult<{skill: SkillRow}>` types; no `@ts-ignore` (good). 12 `eslint-disable`.
- P2 Stale data: global staleTime 15 s + refetchOnWindowFocus + SSE gives acceptable freshness; per-hook overrides (30 s, 60 s, none) are arbitrary. Floor "replay" `at` param is part of the key (fine). No abort signal wiring in queryFn (queries.ts has none), so fast filter changes do not cancel requests.
- P3 `fetch` called directly in 3 files besides client (queries.ts fetchMe, client.ensureCsrf, console streaming): fine but console streaming should live in api/.
- P3 No pagination convention: `Page<T>` exists in types, 8 hooks accept `Page<T> | T[]` (`useActivity`, `useSignins`: `get<EventEntry[] | Page<EventEntry>>`), only 2 view sites use cursors. The union return is a contract smell; normalize in the hook.

## 4. Routing, nav, shell, permissions

- Custom hash router (lib/router.ts, `#/p/<project>/<route>/<param>`), NOT react-router, even though package.json depends on react-router ^7.9.4 (unused dependency, P3: remove, or adopt). One param segment only: sub-tabs, filters, drawer selection and sort are all local state (e.g. conversations.tsx:35 `useState<Tab|null>`, Tabs in 18 files), so tab/filter/drawer are not deep-linkable or shareable and are lost on refresh. Only record (`#/p/x/record/WO-1`) and a few drawers (`useOpenTraveler`, 27 uses) deep link. P1 for an enterprise tool where people share "look at this gate".
- Routes defined in lib/routes.ts (table of 24 routes with `canSee`, `perm`) and views/index.ts (24 lazy imports, a second table) and lib/commands.ts (command palette): three places to edit for a new view.
- P1 Permission gating is dual. Nav visibility = static `anyRole(me, BUILD_READ...)` in routes.ts (roles hard-coded as arrays: `FACTORY_READ`, `BUILD_READ`) AND `perm` asked via `useCan`; comment says "display only, server decides". Inside views: 132 `useCan(` calls feeding `Btn guard=` (good pattern: disabled + reason via `guardProps`), but 37 places check roles directly: views/audit.tsx:39 (`canVerify` from `g.role === "auditor"||"factory_admin"`), home.tsx:60 (`viewerOnly`), console.tsx:49-51 (suggestion lists chosen by role: also a principle issue, "agents propose, code only rails"), govern/data.ts:68 `isAdminLike`. These bypass the policy engine and will disagree with custom roles/policies (the app supports custom roles). Rule: no role-name literals in views; only `useCan(action, scope)`.
- `useCan` results are returned as `Decision` then mapped through a `dec()` helper per view (`const perm = dec(useCan("people.manage"))`, repeated in many files): move into one hook `useGuard(action, ctx)`.
- Shell: Shell.tsx has ErrorBoundary (good) wrapping lazily loaded views; Suspense fallback `null`. Error boundary is per shell only, so one widget crash replaces the whole view; no per-panel boundaries.
- Project switcher drives `prefs.project`; legacy `#floor` redirect logic remains in router (legacy-hash support: dead weight unless old links are needed, P3).

## 5. Code health

Largest non-test files: record/sections2.tsx 615 (the "sections2" name is itself a smell), floor/Belt.tsx 547, people.tsx 485, projects/portfolio.tsx 483, ui/Overlay.tsx 477, floor/Board.tsx 451, record/sections.tsx 446, project-config/flow.tsx 413, home/sections.tsx 404, projects/kit.tsx 394, security.tsx 390, console.tsx 357. Many lines are very long (single-line JSX with nested ternaries and inline handlers, e.g. console.tsx:288-289, conversations.tsx:83, work-orders.tsx:231); line count understates complexity. Files named `*2`, `kit`, `sections`, `misc`, `data` signal absent structure.
- Mixed conventions: top-level view files (`people.tsx`) alongside folder (`people/`), plus `views/index.ts`; `agents.tsx` + `agents/`, etc. (every area has both a `x.tsx` and `x/` dir: 2 patterns for what is one view).
- Dead code: 1 `console.log`, 0 TODO. `react-router` dependency unused; legacy `G.` terminology in comments ("legacy G.ops", "G.emptyState id, kept for fidelity"): the port is still carrying the prototype's shape. `Table` primitive has 1 user. I did not run a dead-export analysis (e.g. ts-prune/knip): recommend it.
- Tests: 33 files/8k lines, 441 pass. Quality: broad (every area has one) but heavily DOM-id/`querySelector` based (738 uses vs 159 `getByRole/getByLabelText/getByText`), 27 of 33 files mock fetch/stubGlobal, so they verify markup fidelity to the legacy app rather than behavior or accessibility; refactors of markup will break them en masse. No visual/e2e tests in this package. No `jest-axe`/axe checks. A single "Errors 1 error" on one run.
- Build script `build` = typecheck + vite build (good). No lint script in apps/web (eslint-disable comments exist, so eslint is configured elsewhere, unverified).

## 6. Accessibility and performance

A11y positives: 237 `aria-label`, `Dialog` focus trap/restore, `aria-live`/`role=alert|status` 118 times, `Toggle` and `Segmented` with radiogroup, reduced motion honored, colors paired with glyphs.
Findings:
- P2 Clickable `<tr>`/`<div>`: 11 non-interactive elements with `onClick`; audit.tsx:128 `<tr onClick>` has no tabIndex/keyboard handler (keyboard users cannot open an audit entry); others reimplement Enter/Space handling. Fix inside `DataTable`.
- P2 Tabs: no `aria-controls`/`tabpanel`, no roving tabindex (all tabs tabbable), arrow keys trigger click (loads data on every arrow).
- P2 Drawer `aria-label="Details"` fixed; popover/menu uses `role="dialog"` without arrow-key nav or `role=menuitem`; Escape handling via per-container onKeyDown only works when focus is inside (a click on non-focusable panel then Esc does nothing).
- P2 Focus trap computes focusables with `offsetParent !== null` (fine) but no `inert`/`aria-hidden` on the background app while a modal is open (screen-reader virtual cursor can leave the dialog).
- P3 6 inputs without `id` (label association relies on `Field htmlFor`; verified only by count). Dialog title id uses `Math.random()` (Overlay.tsx:60-ish, SSR-safe-ness and test-stability: use `useId`).
- P3 `charts.tsx` builds SVG strings with `dangerouslySetInnerHTML` (5 uses incl. Icon): escape-safety depends on callers; labels pass through `aria-label` OK. Low XSS risk since inputs are internal, but chart labels may include user data (agent/team names): verify escaping.
- Perf P2: entry chunk 644 kB / 200 kB gzip (react, react-query, @gantry/domain, shell, ui, all of `api/*`); views lazy-split into 45-67 kB chunks (good). Likely contributors: `@gantry/domain` imported wholesale (statusInfo, DAYS, can()), the icon-path table (ui/icon-paths.ts), prefs, overlay and charts all in entry. Add `manualChunks` for react/query/domain, import icons per use, and prefetch route chunks on nav hover. CSS 262 kB uncompressed in one file: split per-route (import view CSS from the view module so lazy chunk carries it) and drop unused rules. Shell has Suspense fallback null (flash).
- Perf P3: 48 `useMemo`, no list virtualization; tables with 500+ rows (audit, work-orders, activity) render fully (SortTable has "show more" paging only when used; 3 users). Floor Belt/Board are 1k lines of DOM; polling setIntervals re-render full views (floor.tsx:30 `set(n=>n+1)` every tick).

## 7. Target framework

### 7.1 Principles
1. Views compose; they do not style. A view file contains data wiring and layout from templates; no `<table>`, `<button>`, `<input>`, `className="chip..."`, no role literals, no `queryKey: [` literals.
2. One way to do each thing: read (`api/queries`), write (`useCommand`), permission (`useGuard`), async UI (`<Async>`), confirm (`useConfirm`), table (`<DataTable>`), status (`<Badge tone>`).
3. Stay presentation-only about authority: UI never decides rights, it renders server `can` decisions and refusal reasons (matches the product principle: code = rails + human approval; agent-proposed content is rendered, never hard-coded e.g. console suggestion chips by role should come from the server/agent).
4. Keep legacy DOM ids stable for the existing tests by passing `id` through every primitive (see migration).

### 7.2 Folder structure
```
src/
  api/            client.ts, keys.ts, stream.ts, can.ts, types.ts
    queries/      one file per slice: workOrders.ts, projects.ts, people.ts, teams.ts ... (every useQuery lives here)
    commands/     ops split per slice + useCommand.ts (replaces ops.ts monolith gradually)
  ui/                       (design system: no imports from views/ or api/)
    tokens/ tokens.css, spacing, z-index, breakpoints (custom media)
    primitives/ Button, IconButton, Input, Textarea, Checkbox, Radio, Select, Toggle, Field, Badge, Avatar, Icon, Tooltip, KeyValue, Meter
    layout/     Page, PageHeader, Section, Panel, Toolbar, Stack, Split, Grid
    data/       DataTable, List, Pagination, FilterBar, Tabs (routed), Disclosure
    feedback/   Async, Skeleton, EmptyState, ErrorState, InlineAlert, Toast
    overlay/    Dialog, ConfirmDialog, FormDialog, Drawer, Popover, Menu (+ focus-trap, inert)
    content/    Markdown, CodeBlock, Timestamp, Duration
    thread/     Thread, Message, Composer (console, conversations, onboarding, WO session)
    styles/     one css module per component (colocated), loaded with component
  features/                 (domain widgets reused across views)
    work-order/ WoLink, StateChip, WoPicker ; people/ Who, RolePicker ; gates/ GateChip ; agents/...
  views/<area>/             route-level only: index.tsx (+ tabs/, dialogs/), no kit.tsx
  shell/ nav, topbar, palette, stop banner
  lib/ router.ts (typed routes), routes.ts (single registry), prefs, format
```
Rule enforced by lint: `ui/*` cannot import from `views/*`; `views/*` cannot import `@tanstack/react-query` directly or `fetch`.

### 7.3 Component library (concrete props sketch)
```ts
// feedback
<Async query={q} skeleton="table|list|detail" empty={<EmptyState .../>} isEmpty={d=>!d.length}>{(data)=>...}</Async>
  // handles pending (skeleton, no flash <150ms), error (ErrorState with Retry + request id; 403 -> "You can't see this" with needs), empty, stale (dim + "updating")
<EmptyState icon title text action />   <ErrorState error onRetry />   <Skeleton variant="rows|card|text" count />
// status
<Badge tone="neutral|info|run|wait|block|fail|done|accent" icon? mono? size="sm|md">text</Badge>   // replaces chip/tag/pill/state; per-domain maps live in features/*/status.ts: statusBadge(kind, value) -> {tone,label,icon}
// table / list
<DataTable<R> id columns={[{key,header,cell?,sort?,align?,hideBelow?:"sm"|"md",width?}]} rows rowKey
   onRowOpen? (full keyboard: tabIndex, Enter/Space, role=row, aria-selected) selectedKey? sort? onSortChange? 
   pagination={{mode:"cursor"|"client", pageSize}} density="compact|cozy" caption stickyHeader emptyState loading />
   // below 640px renders cards (SortTable's existing behavior generalized)
<List items renderItem selected onSelect />   <KeyValue rows={[[label,value]]} />
<FilterBar value onChange fields={[{type:"search"|"select"|"multi"|"date", key, label, options}]} savedViews? /> // URL-synced (7.5)
// forms
<Input/> <Textarea/> <Select/> <Checkbox/> <Toggle/>  all: {id,label?,hint?,error?,disabled|guard?:Decision,...native}; always forward `id`
<Form form={useForm({initial,validate,onSubmit})}> <Form.Field name label ...> <Form.Actions submitLabel guard/> </Form>
   // form.state: values, dirty, errors (from 422 body mapped to fields), submitting; <SaveBar dirty onSave onDiscard/> for settings pages; If-Match handled by useCommand
// actions
<Button kind="primary|default|danger|ghost" size icon loading guard={Decision} reason? onClick/>  (Btn renamed/aliased)
const confirm = useConfirm(); confirm({title,body,tone:"danger",typeToConfirm?,stepUp?,reason?:true}) -> Promise<{ok, reason?}>
// overlay
<Dialog title size="sm|md|lg" onClose footer> ; <FormDialog form title/> ; <Drawer title tabs? width onClose actions> (aria-label from title; header/body/footer slots; URL-addressable via ?drawer=)
<Menu items={[{label,icon,onSelect,guard,danger}]}/> real role=menu + arrows.
// layout
<Page title kicker? sub? meta? actions? tabs?>…  <Section title tools> <Panel>  <Split list detail/>
// content
<Markdown text /> (moved from views/console, add table/code support, safe link handling) ; <Timestamp at /> <Duration ms />
// thread
<Thread messages renderMeta? onRetry> <Message role author at status="sending|streaming|error|done" actions> <Composer onSend busy placeholder commands? attachments?/>
   // one model: {id, clientId?, role, author, at, text|blocks, status}; console, brief Q&A, WO session and onboarding agent map their data into it
```

### 7.4 Page templates
- ListPage: `<Page title actions><FilterBar/><Async query><DataTable onRowOpen=open/></Async><Drawer/>`. Candidates: work-orders, record/Picker, audit, people list, skills, models, evals, mcp, integrations, api keys/triggers, notifications routes.
- DetailPage: `<Page title tabs(routed)> <Split main aside=<KeyValue/>>` ; used by record, traveler, agent detail, project config overview.
- DrawerDetail: `<Drawer title tabs>` with `<Async>` body and sticky footer actions (floor, onboarding, workload, audit, traveler, integrations instance).
- SettingsPage: `<Page><Form><Section>...</Section><SaveBar/></Form>` for security, access policies, project-config, models routing, agents config; uses If-Match and shows "changed by X, reload" on 409.
- ConsolePage/ThreadPage: `<Page><Split rail=<ThreadList/> main=<Thread><Composer/></Thread>/></Page>` for console, conversations, onboarding agent, WO session.
- DashboardPage (home, floor, trust, workload): `<Page><Grid><Panel>` with `<Async>` per panel and per-panel ErrorBoundary.

### 7.5 Data-access conventions
1. Every read is a hook in `api/queries/<slice>.ts` using `qk.<slice>.*` factories; ban `queryKey: [` literals and ad hoc `useQuery` in views (lint rule `no-restricted-syntax`). One key = one type. Resolve `["teams"]` and `["security"]` collisions immediately.
2. Add `useCommand(opFn, {invalidate?: slices, optimistic?: (qc,args)=>rollback, success?: msg|fn, onRefusal?})` wrapping `ops.*` in `useMutation`: returns `{run, isPending, error}`, toasts via one mapping (403 -> reason+needs, 409 -> "changed by someone else" + reload action, 422 -> field errors to `Form`, network -> retry), auto If-Match from the entity. Retire `useOutcome` and the 31 hand `busy` flags.
3. Narrow invalidation: `ops` declare slices (already) plus optional specific keys; use `setQueryData` for toggles/renames (optimistic) in people roles, trust ladder, notification routes, agent enable.
4. Console keys move into `qk.console.*` and its slice name added to DEPENDENTS/SSE; the server publishes `sessions`, `onboarding`, `console` change events so polling (3 sites) is deleted.
5. Types: ops return `ApiResult<T>` generic per op, eliminating the 56 `as unknown as`.
6. Normalize pagination: hooks return `{items, nextCursor}`; `useInfinite*` for tables.
7. Loading/error always through `<Async>`; no view renders `isLoading` text itself.
8. URL state: `useRouteState({tab, q, sort, filters, drawer})` serializing to hash query (`#/p/x/work-orders?q=..&state=..&open=WO-1`), replacing local tab/filter `useState`; parser extension in lib/router.ts (keep legacy `#floor` redirect until removed).

### 7.6 Permission-gating convention
- One hook: `const g = useGuard("people.manage", {project})` -> `{allowed, pending, reason, needs}`; `<Button guard={g}>`, `<Page guard={g}>` for whole-page read denial, `<Can action=...>fallback</Can>` only for hiding sections (hide only for read; disabled+reason for write).
- Nav: replace `canSee` role arrays with `perm` only (already asked per session via `ROUTE_PERMS`); delete `anyRole/FACTORY_READ/BUILD_READ` and `isAdminLike`. Compute `viewerOnly`, `canVerify` as server-provided actions (`audit.verify`) instead of role names.
- Lint: forbid string literals of role ids in `views/**` and `shell/**` (allow in role admin screens that list roles from the catalog).
- Server refusal reasons (`rule`, `needs`) always surface through `Button` disabled-reason and `useCommand` refusals (already in client types).

### 7.7 Tokens / CSS
Keep tokens.css; add: z-index scale, motion durations, elevation names, breakpoints via `@custom-media` (sm 640, md 900, lg 1100), a `--s0/--s7..` completion, `--control-h`, focus ring token. Convert per-view CSS to colocated component CSS for `ui/*`; views keep only layout classes via `Page/Split/Grid/Stack`. Stylelint rules: no hex outside tokens, no raw px for spacing/radius/font (use vars), no new view-prefixed class when a primitive exists. Goal: view CSS under ~1k lines total from 3.7k.

## 8. Migration plan (incremental, tests stay green)

Constraint: 441 tests assert on legacy ids/classes. Therefore primitives must (a) forward `id`/`data-*`/`aria-*`, (b) emit the legacy class names as additional classes during the transition (e.g. `Badge` adds `chip chip-warn` alongside `badge badge-wait`), and (c) be introduced as drop-in replacements checked by the existing suite. Do not rewrite tests first; rewrite a view's tests to role/label queries only when that view is migrated.

Phase 0 (1-2 days, no behavior change, high value)
 1. Fix key collisions (`teams`, `security`); move the 20 stray hooks into api/queries/*; add lint rule banning `queryKey: [` and direct `useQuery` in views; remove `react-router` dep (or decide to adopt).
 2. `<Async>` + `Skeleton` + `ErrorState`; set Suspense fallback to Skeleton.
 3. Find the flaky unhandled test error; add `--reporter` fail on unhandled, add axe smoke test on 5 views.
 4. Bundle: manualChunks, split CSS by route; measure again (target entry < 350 kB raw).
Phase 1 (week 1) primitives with legacy-class shims
 5. `Badge` (replace 67 chips/14 tags + status maps) - mechanical codemod; `Input/Textarea/Checkbox` (216+44 raw inputs); `Button` replaces 120 raw buttons; `Markdown` to ui/.
 6. `DataTable` generalizing SortTable (row open + keyboard + cards <640px). Migrate in this order by test coverage and simplicity: mcp/Usage, models/Prices, models/Routing, api/Keys, api/Log, notifications tables, evals tables, work-orders, record/Picker, audit (fixes a11y bug), people. 43 files, do ~8 per PR.
 7. `useConfirm`, `FormDialog`, `useForm`, `useCommand`; migrate first the govern/people dialogs (people/InviteDialog, TeamDialog, TeamRoles) then StopDialogs/stepup/override wrap the same `Dialog`.
Phase 2 (week 2) templates and URL state
 8. `Page`, `Section`, `Split`; `Drawer` slots with computed aria-label; `useRouteState` and convert tabs (18 files) to routed tabs, then filters in work-orders/audit/record.
 9. SettingsPage + `SaveBar` + If-Match conflict UX: security, access policies, project-config, models routing, agents config.
Phase 3 (week 3) the hard consolidations
 10. `Thread/Message/Composer`: first conversations/Session (WO session) + onboarding/Agent (similar shape), then conversations/Thread, console last (most behavior, optimistic/streaming logic; give it a message model with `clientId` instead of text/time matching).
 11. Delete per-view kit.tsx files as their contents are replaced (17 files, 2.5k lines) and split `record/sections2.tsx`, `floor/Belt.tsx`, `people.tsx`, `portfolio.tsx` along template boundaries; folder rule: one `index.tsx` per view.
 12. Replace role-literal checks with `useGuard` (37 sites), delete `anyRole` lists from routes.ts, replace console role-based suggestion lists with server/agent-provided suggestions.
Phase 4: SSE slices to replace the 3 polls; optimistic updates for toggles; CSS purge (target 3.7k -> ~1.5k lines of view CSS), stylelint on.

Order of views (best leverage/risk): mcp, models, api, notifications, evals (tables and settings, small) -> work-orders, record/Picker, audit, people (tables + filters) -> security, access, project-config, agents (settings pages) -> trust, learning, integrations, onboarding (drawers/tabs) -> conversations, console (threads) -> floor, home, record detail, traveler (bespoke, touch last: mostly keep their CSS, only swap Badge/Async/Button).

Definition of done per view: no raw `<table>/<button>/<input>`, no `queryKey: [`, no role literals, loads via `<Async>`, all writes via `useCommand`, tabs/filters in URL, test suite for that view uses roles/labels, axe clean.

## 9. Priority summary
- P1: no async-state primitive and ~15 views with no error handling; 67 hand-rolled tables; per-view kit/CSS prefixes; no mutation abstraction (0 useMutation; 31 busy flags); data hooks outside api/ with colliding keys (`teams`, `security`); 4 thread UIs; role literals in 37 UI sites; non-deep-linkable tabs/filters.
- P2: tabs/menu/drawer a11y, audit rows not keyboard accessible, polling vs SSE, casts (56 `as unknown as`), 644 kB entry chunk and 262 kB single CSS, tests coupled to legacy ids, flaky unhandled test error.
- P3: unused react-router dep, legacy-hash support, Dialog id via Math.random, chart SVG strings, `*2.tsx` names.
