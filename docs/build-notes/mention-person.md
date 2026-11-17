# @mention a person in a work-order session

Status: done 2026-11-16 (API, web, tests). Note for `docs/production-readiness.md`: that file is not in this branch's base; the matching backlog line ("@mention a person in a work-order thread") should read: done 2026-11-16, see below.

## Behaviour
- A person who may talk on a work order (the requester, or anyone with `wo.answer`) can mention up to five people in a session message. The composer's `@` offers active people by name (`GET /api/v1/work-orders/{id}/session/people?q=`), and says who cannot read the project yet. The message carries the picked ids (`mentions`); only people still named in the text are sent.
- A mention notifies, it never grants. The mentioned person gets it in their inbox (the bell and Home's waiting list, once they can read the project, until they open the session) and through the project's notification routes for the new `mention` event. When no route carries it, every enabled email connection open to the project sends a plain notice to the person's own address. The email keyword `mentioned` lets a route address them directly.
- If the person cannot read the project: no route carries it, the notice (email only) names nothing about the work order or its text, and an access request opens for the project's admins (one open request per person and project). Admins (`project.members`) see it on Home as an attention item and in `GET /api/v1/access-requests`; they grant a role in the people screen (step-up, audited as any role change) or dismiss it (`POST /api/v1/access-requests/{id}/dismiss`, event `access.request.dismissed`). The author sees a line under their message saying nothing was granted.
- Audit: `wo.mention` (flow), `access.request` and `access.request.dismissed` (access). Tables: `workorder_mentions`, `access_requests` (migration 0034).

## Not done
- A mention in a work order's older Conversation tab (the scripted thread) is not supported; only the session.
- The dismissed request is not shown again in a list; a new mention after dismissal opens a new request.
- Email notices to a person without access are covered by code but not by an automated test (the tests use a Slack connection).
