# Navigation: two levels

Spec.md prescribes no navigation layout, so this is the product decision. Names follow the existing route table.

## IA
```
Factory level (everyone; items filtered by default-deny read permissions)
  Overview : Home | Projects (portfolio, the way to choose a project) | Console
  Project  : header is just "PROJECT"; lists Floor, Work orders, Conversations, Onboarding, Project config
             for the selected project (disabled with "Choose a project" when none)
  Agents   : Agents, Skills, Models, Evals, Trust, Learning
  Connect  : Integrations, Notifications, MCP servers, API & triggers
  Govern   : People & teams, Workload, Access, Security, Audit
Project level (URL carries the project): #/p/<projectId>/<floor|work-orders|conversations|onboarding|project-config|record/<WO>>
```
## Rules
- Top bar: brand, environment badge, project switcher, page-path breadcrumb ("Onboarding" on project pages, "Agents > Evals" on factory pages; hidden on narrow), palette, status, inbox, user. No project selector.
- Top bar, right after the logo and env badge: ONE project switcher (subtle button: full name, truncated past ~28ch with tooltip, muted status text only when not active; "Choose a project" when none). Popover: "All projects (portfolio)", search, Pinned, Recent, All (capped at 40). It is not in the sidebar, icon-rail included. Narrow widths: it shrinks to a short name.
- Sidebar groups: five group headers, all collapsed on a fresh load, accordion (one open), the group holding the current page is marked (accent + bar) but not forced open; following a link collapses it again. Open group kept in sessionStorage only. Arrow/Home/End move between headers. Icon-rail mode and the mobile drawer reuse it.
- The one place to switch project: the top-bar switcher (plus the palette and the portfolio). On factory pages it shows the last project; the Project group acts on it.
- URL wins; `prefs.project` (and recent/pinned lists) is only a remembered default. Legacy `#floor`, `#record/WO-1` redirect (replace) to `#/p/<prefs.project>/...`. Views still read `prefs.project`, which the shell syncs from the URL before rendering a project page.
- Unknown/unreadable project in the URL: "You do not have access to this project" page.
- Landing (empty hash): Factory Admin/Auditor -> Home; exactly one project and no factory role -> that project's Floor; no grants at all -> "No access yet" page.
- Access is default-deny: each factory item has a read action (`agents.view`, `models.view`, `integrations.view`, `people.view`, `policy.view`, `audit.view`) answered by POST /api/v1/can; hidden until allowed. Locked-but-visible items are not used.

## Top bar (calm, one line)
`menu  GANTRY  Project v  > Page      [Search  Ctrl K]   Running   bell   (AR) v`
- No demo text pill. Non-production is a tiny dot on the logo (tooltip) and a muted "Environment: local stack · demo accounts on" line at the top of the account menu; the sign-in page keeps its own notice.
- Project button: name and caret only; a coloured dot only for halted/killed (status per row in the popover).
- Breadcrumb joins with a ">" on project pages and a subtle divider on factory pages (page path only).
- Status is a compact chip ("Running", amber/red states); clock, shift, open windows and freezes are in its popover (`#status-cluster`).
- Search is a narrow field that widens on hover/focus and becomes an icon at narrow widths. User is avatar + caret (name in the menu header/tooltip). All controls are 32px high.

## Icon rail
The top-bar menu button is the only sidebar toggle (desktop: expanded <-> icon rail, remembered in prefs; narrow: opens/closes the drawer). The rail shows only the five group icons (labelled, tooltip, active group marked, Project disabled without a project). A group button opens a menu popover of that group's items (same permission filtering), Esc/click-outside closes, arrow keys move, choosing an item navigates and closes. The flyout is a popover anchored to the button (below it), not a side panel.
