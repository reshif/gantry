# Gantry UI rules

These rules apply to every screen. A view is not done until it follows them and a screenshot of it, in light and dark at 1440 px and 390 px wide, has been checked against this page.

## 1. What the factory view must answer

Before drawing anything, ask: who is looking, and what do they need to grasp in three seconds?

| Who | Question they bring | Where the answer lives |
|---|---|---|
| Requester | Where is my work order, and is anyone waiting on me? | Home "Waiting on you", the work order's traveler |
| Approver, line lead | What is waiting at a gate, what is stuck, and who has to act? | Floor, Home |
| Project admin | Is the line healthy and within budget? | Floor stats, project overview |
| Factory admin, auditor | Which projects need attention, and is anything stopped? | Home, Projects |

From this it follows that:

- **Work moves left to right, in one line.** The line never wraps back on itself. When it doesn't fit, it scrolls sideways; on a phone it becomes a vertical list, top to bottom.
- **A gate is a checkpoint between two stations,** drawn as one diamond with its state glyph and the number of work orders waiting there. Its name appears on hover and focus, and in the legend. It is never a text label squeezed between columns.
- **Bays sit off the line, in their own labelled row underneath.** Bays are the places that hold work that left the line, such as Declined, On hold and Security hold.
- **Empty means quiet.** A station with nothing in it is drawn faintly, without a "0" box. Numbers appear only where there is work, so the eye goes straight to it.
- **One drawing everywhere.** Home, Projects, project overview and the Floor all draw the line with the same `FlowStrip` component, in a compact size or a full size, never an ad-hoc row of boxes.

## 2. Colour and status

Colour carries meaning, so each colour means exactly one thing:

| Tone | Meaning | Examples |
|---|---|---|
| accent (blue) | interactive, selected | links, primary buttons, the current tab |
| run (teal) | an agent is working | Running |
| wait (amber) | waiting on a person | Waiting on gate, Needs answer |
| block (red) | stopped or refused | Blocked, Halted, Failing |
| fail (magenta) | an agent or check failed | Failed |
| done (green) | finished or healthy | Done, Healthy, Ready |
| neutral (grey) | inactive or informational | Off, Draft, built-in |

There is one status component, `<Status tone="…">`. It always has a glyph and a word, in sentence case, with the same shape everywhere. No upper-case status boxes, and no bare coloured dots. A status must not contradict the numbers next to it: an integration with failed deliveries is not "Healthy".

## 3. Page anatomy

Every page has the same skeleton, top to bottom:

1. **Top bar** (shell): project switcher, breadcrumb, search, factory status, notifications, account. The breadcrumb is the only place that says where you are.
2. **Page header:** the title on the left, in sentence case. The actions sit on the right of the same row, primary action last. One line of description sits under the title. There is no kicker that repeats the breadcrumb and no spec references ("Sheet 13"). A detail page may use a kicker for the entity type ("Agent", "Work order").
3. **Stats:** an optional single row of equal tiles under the header, each with a label, a value and an optional note. There is no floating box of stats in the corner.
4. **Tabs**, if the page has them.
5. **Toolbar:** filters on the left, the result count and secondary actions on the right. It never repeats an action the header already has.
6. **Content:** sections and panels on a 12-column grid. Use the main column alone, or main plus an 8/4 side column. Nothing else.

The vertical position of the title is the same on every page.

## 4. Building blocks (in `apps/web/src/ui/`)

| Need | Use | Not |
|---|---|---|
| Page title, actions | `PageHeader` | hand-made headings |
| Numbers row | `StatStrip` | `titleblock`, ad-hoc KPI grids |
| Status | `Status` | `chip-warn`, `.health`, bespoke pills |
| Small label | `Tag` | ad-hoc `*-tag` classes |
| Loading, error, empty, no access | `Async`, `EmptyState` | blank areas, raw messages |
| Table | `DataTable` | raw `<table>` |
| Filters | `FilterBar` (inline, compact, URL-synced) | a grid of labelled selects |
| Factory line | `FlowStrip` | rows of boxes |
| Writes | `useCommand` | hand-written busy flags |
| Permission checks | `useGuard` | role-name checks |

## 5. Text

- Use sentence case for titles, panel titles, buttons and statuses. Mono upper-case is only for small labels (table headers, stat labels).
- Use names, not ids: "Asha Raman", not "p-asha". Show an id only next to its name, in mono.
- When the person can't see something, say "Not visible to you", never "0".
- A locked control says why on hover, focus and tap.

## 6. Checklist before calling a view done

- [ ] Follows the page anatomy, with the title at the same height as on other pages.
- [ ] Statuses use `Status`, and no colour is used for anything other than its meaning.
- [ ] Every async area handles loading, error, empty and 403.
- [ ] No duplicated actions, and no status chips mixed in among buttons.
- [ ] Screenshots are checked in light and dark, at 1440 and 390 wide, with no clipped or overlapping text and no horizontal page scroll.
