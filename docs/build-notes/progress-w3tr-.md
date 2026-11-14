# progress w3tr- (traveler drawer, record, conversations)
Files: apps/web/src/views/{traveler,record,conversations}.tsx + subfolders traveler/ record/ conversations/, shell/useTraveler.tsx.
Harness: docker run -d --name w3tr-pg -e POSTGRES_PASSWORD=pw -p 55451:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine -c fsync=off -c max_connections=200
 cd services/api; W3FL_PORT=8151 GANTRY_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55451/postgres npx vitest run test/w3tr-harness.test.ts --testTimeout=0  (delete the file at the end)
DONE: read legacy traveler/conversations/record.
NEXT: inspect real api shapes, then write views.
DONE: traveler/{model,state}.ts, shell/useTraveler.tsx, record/{data.ts,bits.tsx}. NEXT: record/sections.tsx, record/Lifecycle.tsx, traveler/Drawer+actions+dialogs, conversations, record view+picker, tests, screenshots
DONE: record/{data.ts,bits.tsx,sections.tsx,sections2.tsx,Lifecycle.tsx,nav.ts} typecheck ok. NEXT: record.tsx view+Picker, traveler Drawer/actions/dialogs, conversations, tests, screenshots
DONE: record view/Picker, traveler/Journey.tsx. NEXT: traveler Drawer/Actions/Dialogs/tabs, conversations, tests, harness run, screenshots
DONE: conversations/{model,Thread,Brief}, conversations.tsx. NEXT: traveler Drawer(Actions,Dialogs,Tabs), tests, harness run, screenshots
DONE: traveler/{Drawer,Actions,Dialogs,Tabs,Journey,state,model,repo}, traveler.tsx; all typecheck. NEXT: run web dev (vite :5198 -> api :8151, harness running), drive with playwright, fix gaps; web tests; screenshots vs legacy
VERIFIED LIVE: approve, reject, sendback, park, unpark, retry. NEXT: reassign(agents endpoint missing 404), reclass, conversation controls (answer chip/text, followup, raise question, confirm, decline), record summary edit/export/copy, tests, screenshots compare
VERIFIED LIVE: reassign api, reclass, answer, followup, confirm, raise q, decline, summary edit, export, copy md, scrubber. NEXT: vitest tests (views/traveler.test.tsx, record.test.tsx, conversations.test.tsx), final screenshots (compare), cleanup (harness file, pg container, vite)
DONE: tests traveler/record/conversations pass. NEXT: full web test run, final screenshots (picker etc), reset harness + final live exercise, cleanup
FINISHED: all views done and verified live; harness file removed, w3tr-pg removed. Web tests: npx vitest run (apps/web) -> 153 pass.
