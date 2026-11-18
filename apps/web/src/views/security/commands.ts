/** The one place the Security screen writes (PATCH /security, DELETE /sessions/:id): thin wrappers so the views keep a single ops import. */
import { ops } from "../../api/ops";

export const setSecurity = ops.setSecurity;
export const revokeSession = ops.revokeSession;
