/**
 * Wire types for the web client.
 *
 * Entity shapes (Person, Project, WorkOrder, ...) come from @gantry/domain, which is the shared
 * contract with the API. The shapes below exist only because they are API envelopes (`me`, `can`,
 * `stream`) that the domain package does not define. Integration note: if @gantry/domain later
 * exports `Me` / `CanCheck` / `CanResult`, replace these with re-exports.
 */
import type {
  Decision,
  FactoryState,
  GantryState,
  Org,
  Person,
  Project,
  RuleRef,
  Session,
} from "@gantry/domain";

export type { Decision, FactoryState, GantryState, Org, Person, Project, RuleRef, Session };

/** Slice names of the legacy G.store. SSE `change` events and query keys use these. */
export type SliceName = keyof GantryState | (string & {});

/** One demo account on the sign-in screen (development only). */
export interface DemoAccount {
  id: string;
  name: string;
  email: string;
  role: string;
  note: string;
}

/** Public configuration the sign-in screen needs before anyone is signed in. */
export interface PublicConfig {
  /** True when GANTRY_DEV_DEMO_ACCOUNTS is on: the seeded Keycloak users may be listed. */
  demoAccounts: boolean;
  /** Optional server-supplied list. When absent and demoAccounts is on, the client uses DEMO_ACCOUNTS. */
  demoAccountList?: DemoAccount[];
  /** Whether the GitHub sign-in method is enabled in Security settings. */
  githubLogin?: boolean;
  orgName?: string;
}

/**
 * GET /api/v1/me. Person, roles per project (on person.roles), visible projects, session,
 * the CSRF token for state-changing requests, and the factory stop state.
 */
export interface Me {
  person: Person;
  session: Session;
  csrf: string;
  org?: Org;
  /** Projects the person holds a role in (the legacy G.visibleProjects). */
  projects: Project[];
  factory: FactoryState;
  config: PublicConfig;
}

/** Body of a 401 from GET /api/v1/me: nobody is signed in. */
export interface SignedOut {
  ok: false;
  msg: string;
  config?: PublicConfig;
}

export interface CanCheck {
  action: string;
  project?: string;
  repo?: string;
  time?: number;
}

/** POST /api/v1/can result element. */
export interface CanResult {
  allowed: boolean;
  reason: string;
  rule?: RuleRef | null;
  needs?: string;
}

export interface CanResponse {
  results: CanResult[];
}

/** SSE `change` event payload. */
export interface ChangeEvent {
  keys: string[];
  project?: string;
}

/** What the nav shows next to a route (legacy G.navBadges). */
export interface NavBadge {
  n?: number;
  text?: string;
  kind?: string;
  label: string;
}

/** GET /api/v1/home: figures, attention queue, my approvals, my conversations, nav badges. */
export interface HomeData {
  figures?: Record<string, unknown>;
  attention?: unknown[];
  approvals: Array<{ wo?: string; title?: string; gate?: string; gateLabel?: string; gateName?: string; project?: string; projectName?: string; repo?: string; repoName?: string; pr?: number }>;
  conversations: Array<{ wo: string; title: string; project: string }>;
  badges?: Record<string, NavBadge>;
  factory?: FactoryState;
  [extra: string]: unknown;
}

/* ---------- read envelopes that wrap legacy slices ---------- */

import type {
  Agent,
  ApiConfig,
  ApiKey,
  AuditEntry,
  CardTemplate,
  Conversation,
  Delivery,
  EvalRun,
  EventEntry,
  Freeze,
  IntegrationInstance,
  IntegrationType,
  LearningFinding,
  LearningProposal,
  Matrix,
  McpServer,
  Policy,
  Repo,
  RequestLogEntry,
  Role,
  Action,
  Routing,
  Scorecard,
  SecuritySettings,
  SignIn,
  Skill,
  Template,
  Trigger,
  TriggerRun,
  Trust,
  Vendor,
  WorkOrder,
  Team,
  OrgGuidelines,
  AgentInstructions,
  Suite,
  EvalExtra,
  McpUsage,
} from "@gantry/domain";

export type {
  Agent, ApiConfig, ApiKey, AuditEntry, CardTemplate, Conversation, Delivery, EvalRun, EventEntry, Freeze,
  IntegrationInstance, IntegrationType, LearningFinding, LearningProposal, Matrix, McpServer, Policy, Repo,
  RequestLogEntry, Role, Action, Routing, Scorecard, SecuritySettings, SignIn, Skill, Template, Trigger,
  TriggerRun, Trust, Vendor, WorkOrder, Team, OrgGuidelines, AgentInstructions, Suite, EvalExtra, McpUsage,
};

/** GET /api/v1/projects/{id}/floor: flow version, positions, gates, slots, stop state. */
export interface FloorData {
  project: Project;
  workOrders: WorkOrder[];
  slots?: { used: number; total: number; [k: string]: unknown };
  stop?: { mode: string; reason: string; by: string; at: number; [k: string]: unknown } | null;
  flowVersion?: number;
  at?: number | null;
  [extra: string]: unknown;
}

/** Cursor-paged list. `next` is the cursor for the following page, absent on the last. */
export interface Page<T> {
  items: T[];
  next?: string | null;
  total?: number;
}

export interface AuditFilters {
  category?: string;
  project?: string;
  actor?: string;
  outcome?: string;
  channel?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface AccessMatrixData {
  matrix: Matrix;
  roles: Role[];
  actions: Action[];
  version?: number;
}

export interface Workload {
  [k: string]: unknown;
}

export interface SavedView {
  id: string;
  name: string;
  [k: string]: unknown;
}

export interface KillImpact {
  projects?: number;
  workOrders: number;
  running: number;
  slots: number;
  prs: number;
}

export interface RecordBundle {
  [k: string]: unknown;
}
