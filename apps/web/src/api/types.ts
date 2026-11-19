/**
 * Wire types for the web client.
 *
 * Entity shapes (Person, Project, WorkOrder, ...) come from @gantry/domain, which is the shared
 * contract with the API. The shapes below exist only because they are API envelopes (`me`, `can`,
 * `stream`) that the domain package does not define. Integration note: if @gantry/domain later
 * exports `Me` / `CanCheck` / `CanResult`, replace these with re-exports.
 */
import type { GateLockView } from "@gantry/domain";
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
  /** True when the demo organisation is seeded (GANTRY_DEV_SEED) on a local stack: the seeded Keycloak users may be listed. */
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
  /** Only a Factory Admin override would allow it (`overrideReason: "required"`), or the sole admin restoring the factory. */
  override?: boolean;
  overrideReason?: string;
  overrideKind?: string;
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
  approvals: Array<{ wo?: string; title?: string; gate?: string; gateLabel?: string; gateName?: string; project?: string; projectName?: string; repo?: string; repoName?: string; pr?: number; note?: string }>;
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
  TriggerProposal,
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
  TriggerProposal, TriggerRun, Trust, Vendor, WorkOrder, Team, OrgGuidelines, AgentInstructions, Suite, EvalExtra, McpUsage,
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

/** GET /workload: figures computed on the server from the work order records (spec 13.5), scoped to the projects the viewer sees. */
export interface WorkloadWo {
  id: string;
  title: string;
  project: string;
  cls: string;
}
export interface WorkloadAct {
  kind: "approve" | "confirm" | "answer";
  at: number;
  wo: string;
  gate?: string;
  waitMin: number | null;
}
export interface WorkloadRow {
  person: string;
  name: string;
  team: string | null;
  waiting: number;
  glass: number;
  approvals: number;
  perDay: number;
  answered: number;
  waitN: number;
  medianResponseMin: number | null;
  afterHours: number;
  n: number;
  sole: number;
  minutes: number;
  away: { from: number; to: number; delegate: string | null } | null;
  oncall: boolean;
  waitingGates: Array<{ wo: WorkloadWo; gate: string; since: number; eligible: number }>;
  recent: WorkloadAct[];
}
export interface WorkloadTeam {
  team: string;
  name: string;
  people: number;
  waiting: number;
  approvals: number;
  answered: number;
  minutes: number;
  waitN: number;
  medianResponseMin: number | null;
  afterHours: number;
  n: number;
  sole: number;
}
export interface WorkloadMinutes {
  key: string;
  minutes: number;
  workOrders: number;
  perWO: number;
}
export interface WorkloadBottleneck {
  project: string;
  gate: string;
  decisions: number;
  medianWaitMin: number | null;
  open: number;
  oldestMin: number;
  station: string | null;
  minEligible: number | null;
}
export interface WorkloadSuggestion {
  key: string;
  kind: "approver" | "trust" | "delegate";
  icon: string;
  weight: number;
  text: string;
  action: { id: string; label: string; type: "config" | "delegate" | "person" | "trust"; project?: string; gate?: string | null; person?: string; cell?: string; cls?: string | null; proposal?: string | null };
}
export interface Workload {
  at: number;
  days: number;
  scope: string;
  minN: number;
  projects: Array<{ id: string; name: string }>;
  factoryWide: boolean;
  ids: string[];
  totals: { gatesWaiting: number; soleGates: number; noneGates: number; timedN: number; medianWaitMin: number | null; acts: number; afterHours: number; minutes: number };
  rows: WorkloadRow[];
  teams: WorkloadTeam[];
  byCls: WorkloadMinutes[];
  byProject: WorkloadMinutes[];
  bottlenecks: WorkloadBottleneck[];
  needsPerson: Array<{ id: string; title: string; project: string; bayReason: string | null }>;
  suggestions: WorkloadSuggestion[];
}

/** GET /learning/signals: one row per signal, newest first. A regression has no work order; its eval run is in `ref`. */
export interface LearningSignalRow {
  signal: string;
  wo: string;
  project: string | null;
  agent: string | null;
  gate?: string;
  text: string;
  at: number;
  ref?: string;
}
/** GET /learning/settings. */
export interface LearningSettings {
  proposalsOn: boolean;
  /** People other than the viewer who could decide a proposal: the drafter does not accept where this is above zero. */
  otherDeciders: number;
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

/* ---------- agents: server-composed reads (GET /agents/{id}/effective, /agents/suites) ---------- */

export interface AgentEffective {
  agent: string;
  /** A version label, or "draft" for the saved working configuration. */
  version: string;
  live: boolean;
  project: { id: string; name: string } | null;
  repo: { id: string; name: string } | null;
  /** The whole system prompt a run is sent. */
  text: string;
  hash: string;
  promptHash: string;
  sections: Array<{ key: string; title: string; source: "layer" | "skill" | "runner"; text: string; words: number }>;
  handoff: { first: string; json: string[] };
  draft: boolean;
  words: number;
  tokens: number;
  layers: Array<{ key: "base" | "project" | "agent" | "repo"; name: string; version: number | null; hash: string; text: string; commit?: string | null }>;
  skills: Array<{ id: string; name: string; version: number; label: string; when: string; resources: string[]; content: string }>;
  /** The repository's own convention files as last offered to a run (from the repo itself, not the repo guidelines text). */
  repoContext?: {
    commit: string;
    runId: string;
    offeredAt: string | null;
    files: Array<{ path: string; bytes: number; sha256: string; inlined: boolean; truncated: boolean; withheld?: "secret" | "cap" | "too_large" }>;
  } | null;
}
export interface AgentSuite {
  id: string;
  name: string;
  station: string | null;
  agent: string | null;
  threshold: number;
}

/** What GET /projects adds to every project about the flow's locks (the server decides who may override; never a role name here). */
export interface FlowOverrideView {
  viewerMayOverride: boolean;
  minReasonLength: number;
  locks: Record<string, GateLockView>;
}
