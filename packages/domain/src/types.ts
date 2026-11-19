/**
 * Typed shapes of every legacy `G.store` slice. Field names are the legacy field names exactly:
 * the React port and the API both use them. Timestamps are epoch milliseconds.
 */
export type Id = string;
export type Ms = number;

/* ------------------------------------------------------------------ catalogue ---------- */

export interface Station {
  id: string;
  no: string;
  name: string;
  agent: Id;
  purpose: string;
  custom?: boolean;
  project?: Id;
}

export type GateKind = "human" | "auto" | "mixed";

export interface Gate {
  id: string;
  label: string;
  name: string;
  after: string;
  kind: GateKind;
  purpose: string;
  checks: string[];
  action?: string;
  custom?: boolean;
  project?: Id;
}

export interface Bay {
  id: string;
  name: string;
  desc: string;
  custom?: boolean;
  project?: Id;
}

export type Priority = "P0" | "P1" | "P2" | "P3";
export type Estimate = "S" | "M" | "L";

export interface WorkClass {
  id: string;
  name: string;
  skips: string[];
  priority: Priority;
  slaH: number;
  est: Estimate;
  splits?: boolean;
  endsAfter?: string;
  /* project-level and custom classes */
  enabled?: boolean;
  token?: string;
  shape?: string;
  hints?: string[];
  gates?: string[];
  custom?: boolean;
  project?: Id;
}

export type RoleLevel = "factory" | "project";
export interface Role {
  id: string;
  name: string;
  level: RoleLevel;
  custom?: boolean;
  base?: string | null;
  desc?: string;
}

export type ActionScope = "project" | "factory";
export interface Action {
  id: string;
  name: string;
  scope: ActionScope;
  group: string;
}

/** The pieces of the catalogue that are not fixed: built-ins plus custom entries added per project. */
export interface Catalog {
  stations: Station[];
  gates: Gate[];
  bays: Bay[];
  classes: WorkClass[];
  roles: Role[];
  actions: Action[];
}

/**
 * `blocked` is reserved: no engine path sets it today (a work order that cannot go on is `failed`, or `parked` in a bay such as Needs a person; a merge that
 * cannot happen is parked with bayCause "merge"). Retry, Home, the session and the board still treat it as live, so a future producer or an imported row behaves
 * like `failed`. Statechart model, gap 7: the handling is kept and documented rather than removed; `lifecycle-gaps.test.ts` fails if something starts setting it
 * without this note being revisited.
 */
export type WoStateId = "running" | "waiting" | "blocked" | "failed" | "parked" | "killed" | "done";
export interface WoStateInfo {
  label: string;
  glyph: string;
}

export interface Template {
  id: Id;
  name: string;
  desc: string;
  stationsOff: string[];
  gatesOff: string[];
  slots: number;
  classesSkip: Record<string, string[]>;
  mcp: Id[];
  approverPreset: "standard" | "light" | "strict";
  /** Approver rules saved from a project (counts, escalation hours, conditions, fallback, separation of duties); a project made from it starts with these instead of the preset (S-58). */
  approvers?: Record<string, ApproverRule>;
  notify: "standard" | "light" | "strict";
  builtIn: boolean;
  order?: string[];
  bays?: string[];
}

/** Role -> action -> granted. */
export type Matrix = Record<string, Record<string, boolean>>;

/* ------------------------------------------------------------------ org, people, teams --- */

export interface Org {
  id: Id;
  name: string;
  plant: string;
  tz: string;
}

export interface KillInfo {
  by: Id;
  at: Ms;
  reason: string;
  scope?: string;
  mode?: "hold" | "cancel";
}

export interface FactoryState {
  killed: KillInfo | null;
}

export interface Team {
  id: Id;
  name: string;
  desc: string;
  /** Roles the team holds; its members inherit them while they are members (spec 8.9). Present on `GET /teams`. */
  roles?: TeamGrant[];
}

/** One live role grant held by a team. */
export interface TeamGrant {
  id: string;
  role: string;
  /** "factory" or a project id. */
  scope: string;
  grantedBy: string | null;
  /** Epoch ms; null = no expiry. */
  expiresAt: Ms | null;
}

export interface RoleGrant {
  role: string;
  /** "factory" or a project id. */
  scope: string;
  /** Set when the person holds the role through a team (the team id) rather than a grant of their own. */
  via?: Id;
}

export interface Away {
  from: Ms;
  to: Ms;
  delegate: Id | null;
}

export type PersonStatus = "active" | "invited" | "deactivated" | (string & {});
export interface Person {
  id: Id;
  name: string;
  title: string;
  email: string;
  teams: Id[];
  roles: RoleGrant[];
  status: PersonStatus;
  oncall: boolean;
  github: string;
  away: Away | null;
  mfa?: boolean;
  /** Record version (read only). Sent as If-Match by offboarding. */
  version?: number;
  invitedBy?: Id;
  invitedAt?: Ms;
}

/* ------------------------------------------------------------------ projects & flow ----- */

export type ProjectStatus = "active" | "onboarding" | "new" | "archived";

/** Who turned something off or changed a locked mode against its lock, when and why (a Factory Admin override, owner decision 2026-11-19). */
export interface FlowOverrideMark {
  by: string;
  byName: string;
  at: number;
  reason: string;
  /** For a mode override: the mode before. */
  from?: GateKind;
}
export interface StationConfig {
  enabled: boolean;
  wip: number;
  absent?: boolean;
  /** Set while the station is off by a Factory Admin override of a lock it carries. */
  override?: { off?: FlowOverrideMark };
}
export interface GateConfig {
  enabled: boolean;
  mode: GateKind;
  absent?: boolean;
  /** Set while the gate is off, or in a locked mode, by a Factory Admin override. */
  override?: { off?: FlowOverrideMark; mode?: FlowOverrideMark };
}
export interface ProjectFlow {
  stations: Record<string, StationConfig>;
  gates: Record<string, GateConfig>;
  slots: number;
  classes: WorkClass[];
  order: string[];
  bays: string[];
}

export type ConditionType = "class" | "risk" | "path";
export interface ApproverNeeds {
  roles: string[];
  people: Id[];
  oncall: boolean;
}
export interface ApproverCondition {
  id: string;
  when: { type: ConditionType; value: string };
  needs: ApproverNeeds;
  text: string;
}
export interface ApproverRule {
  roles: string[];
  people: Id[];
  required: number;
  /**
   * Per-work-class override of `required`: class id -> approvals needed for work orders of that class. It changes the COUNT only, for a listed class.
   * A class without an entry uses `required`. It never touches `sod` and never makes a gate optional (every count is a whole number of at least 1).
   */
  classRequired?: Record<string, number>;
  sod: boolean;
  conditions: ApproverCondition[];
  escalateH: number;
  fallback: Id | null;
  note?: string;
}

export type Channel = "slack" | "email" | "paging" | "teams" | "webhook" | (string & {});
export interface Destination {
  channel: Channel;
  target: string;
  integration?: Id | null;
  override?: string | null;
}
export interface RouteCondition {
  classes: string[];
  priority: string[];
  hours: "any" | "business";
}
export interface NotificationRoute {
  id: string;
  event: string;
  dest: Destination[];
  template: string;
  cond: RouteCondition;
  enabled: boolean;
  fields: { title: boolean; repo: boolean; class: boolean; priority: boolean; approvers: boolean; link: boolean };
}

export interface ProjectBudget {
  /** The monthly cap in USD. Read it with `capped`: 0 with capped true is a real $0 cap (nothing metered runs); 0 with capped false is no cap. */
  monthly: number;
  /** True when a monthly cap is in force (an amount above 0, or a $0 cap a person set). */
  capped: boolean;
  mtd: number;
  alertAt: number;
}

export interface GuidelineItem {
  id: string;
  text: string;
  required: boolean;
}
export interface GuidelineVersion {
  v: number;
  at: Ms;
  by: Id;
  note: string;
}
export interface ProjectGuidelines {
  items: GuidelineItem[];
  notes: string;
  version: number;
  history: GuidelineVersion[];
}
export interface OrgGuidelines {
  version: number;
  by: Id;
  at: Ms;
  items: GuidelineItem[];
  may: string;
  mayNot: string;
  history: GuidelineVersion[];
}

export interface HaltInfo {
  by: Id;
  at: Ms;
  reason: string;
  /** Why the halt exists: `manual` (a person), `budget` or `readiness` (Gantry raised it). Absent on older data. */
  cause?: string;
}

export interface Project {
  id: Id;
  name: string;
  key: string;
  status: ProjectStatus;
  teams: Id[];
  owner: Id;
  template: Id;
  regulated: boolean;
  desc: string;
  flow: ProjectFlow;
  approvers: Record<string, ApproverRule>;
  notifications: NotificationRoute[];
  mcp: Id[];
  budget: ProjectBudget;
  created: Ms;
  halted: HaltInfo | null;
  killed: KillInfo | null;
  overlay: string;
  guidelines?: ProjectGuidelines;
  /** People on call for this project, chosen by its admins. Factory Admins always count as on call too (see isOnCall). */
  oncall?: Id[];
  [extra: string]: unknown;
}

/* ------------------------------------------------------------------ repos & onboarding -- */

export type OnboardStage = "connected" | "assessed" | "pr_opened" | "pr_checks" | "pr_merged" | "verified" | "ready" | "failed" | "person";
export type Severity = "high" | "medium" | "low";

export interface OnboardFinding {
  id: string;
  check: string;
  ok: boolean;
  sev: Severity;
  fix: string;
  file: string | null;
  manual?: boolean;
  /** A gap in a required check blocks Ready; an advisory one is only listed. Absent on seeded demo data. */
  required?: boolean;
  /** What the assessment read to decide. Never a secret value. */
  detail?: string;
  /** Where the finding comes from. `observed`: Gantry read it from the repository (always the case for ok, severity and required). `agent`: an explanation or suggestion the Onboarding Agent added on top of an observed finding. Absent on older data (read as observed). */
  source?: "observed" | "agent";
  /** The Onboarding Agent's own explanation of the finding; shown beside the observed detail, never in place of it. */
  note?: string;
}
export interface OnboardPrFile {
  path: string;
  plus: number;
  minus: number;
  finding: string;
  /** `agent` when the Onboarding Agent drafted the content of this file; `observed` when Gantry wrote it from the repository's own files. */
  source?: "observed" | "agent";
}
/** Who made an assessment or drafted a pull request: the rule-based path, or a real run of the Onboarding Agent. */
export interface OnboardAssessor {
  mode: "rule-based" | "agent";
  /** Why the agent did not run or its output was not used (only when mode is rule-based). */
  reason?: string;
  /** The agent run (a hidden carrier attempt) and what it ran as: only when mode is agent. */
  runId?: string;
  agent?: string;
  version?: number;
  model?: string;
  instructionsHash?: string;
  skills?: Record<string, number>;
  costUsd?: number;
  tokens?: number;
  /** The agent's overall risk judgement and summary (assessment only). */
  risk?: { level: "low" | "medium" | "high"; reason: string };
  summary?: string;
  /** Commands the agent found for unusual layouts. Suggestions, not observed facts. */
  commands?: Partial<Record<"test" | "lint" | "build" | "install", string>>;
  forPeople?: string[];
  guidelineSuggestions?: string[];
}
export interface OnboardPr {
  number: number;
  title: string;
  branch: string;
  files: OnboardPrFile[];
  /** `none`: nothing (no check run, no commit status) reported within the grace period after the head was pushed: the repo has no CI. */
  checks: "pending" | "running" | "green" | "red" | "none";
  state: "open" | "merged" | "closed";
  reviewers: Id[];
  mergedBy: Id | null;
  /** The pull request on GitHub and its head commit (what a merge is requested for). */
  url?: string;
  headSha?: string;
  /** When Gantry first saw this head commit (epoch ms): the grace period for "no CI" counts from it. */
  headAt?: number;
}
export interface TimelineEntry {
  at: Ms;
  who: Id;
  text: string;
}
export interface RepoOnboarding {
  stage: OnboardStage;
  findings: OnboardFinding[];
  pr: OnboardPr | null;
  timeline: TimelineEntry[];
  exception: { by: Id; at: Ms; reason: string } | null;
  startedAt: Ms;
  readyAt?: Ms;
  blocker?: string;
  /** Work the worker is doing for this repo right now (a command returned before it finished). */
  busy?: "assessing" | "opening_pr" | "updating_pr" | "merging" | "verifying" | null;
  /** The last live verification (spec 11.3 "Verified means"): each check with its result. */
  verification?: { at: Ms; ok: boolean; trigger: "merge" | "manual" | "schedule"; unknown: boolean; checks: Array<{ id: string; label: string; ok: boolean; unknown?: boolean; detail: string; /** Set when this result is carried over from an earlier verification because the latest one did not run that check (the canary runs once a day). */ at?: number }> } | null;
  /** The adapter the assessment ran with: `rule-based` (deterministic, reads the repo's facts, no model) or `agent` (the Onboarding Agent ran on top of the observed facts). */
  adapter?: string;
  /** Who assessed (see OnboardAssessor) and who drafted the pull request. */
  assessor?: OnboardAssessor;
  drafter?: OnboardAssessor;
  /** A later assessment found the open onboarding PR out of date: it needs an update (approved in the session). */
  prNeedsUpdate?: boolean;
  /** Guideline versions the assessment was made against. */
  guidelines?: { org: number; project: number };
}
export interface RepoConfig {
  defaultBranch: string;
  branchPrefix: string;
  merge: "squash" | "merge" | "rebase";
  tagging: string;
  requiredChecks: string[];
  protectedPaths: string[];
}
export interface NotifyOverride {
  id: string;
  event: string;
  dest: Destination[];
  template: string;
  mode: "also" | "instead";
}
export interface Repo {
  id: Id;
  /** "owner/name" */
  name: string;
  project: Id;
  team: Id;
  tags: string[];
  lang: string;
  halted: HaltInfo | null;
  config: RepoConfig;
  mcp: Id[];
  notifyOverrides: NotifyOverride[];
  triggers: boolean;
  guidelines: string;
  onboarding: RepoOnboarding;
  source?: Id;
  freeze?: boolean;
}

/* ------------------------------------------------------------------ work orders --------- */

export type GateStatus = "pending" | "waiting" | "passed" | "failed";
export interface Approval {
  by: Id;
  at: Ms;
  via: string;
  /** The seat this vote fills when the voter acted as the stand-in of an away approver (S-53): the away person's id. Absent for a vote in the voter's own seat. */
  for?: Id;
}
export interface Rejection {
  by: Id;
  at: Ms;
  reason: string;
}
export interface GateCheck {
  name: string;
  ok: boolean;
  warn?: boolean;
  note?: string;
}
export interface GateDecisionRecord {
  mode: "human" | "auto" | "trust" | "hold" | "cancel" | (string & {});
  by?: Id;
  at: Ms;
  via?: string;
  trust: number | null;
  reason?: string;
}
export interface GateInstance {
  status: GateStatus;
  approvals: Approval[];
  rejections: Rejection[];
  checks: GateCheck[];
  waitingSince?: Ms;
  /** The approvals this opening was opened with. A later loosening of the rule never lowers what a waiting gate needs (spec 9.3), so progress and the satisfiable warning use it too. */
  openedRequired?: number;
  decision?: GateDecisionRecord;
  trustNote?: string | null;
  /** The gate waited past its escalation limit: the rule's fallback approver (else the project owner) may approve it from then on. */
  escalated?: boolean;
}

export interface HistorySkill {
  id: Id;
  name: string;
  v: string;
}
export interface Artefact {
  kind: string;
  title: string;
  body: string;
}
export interface HistoryEntry {
  station: string;
  agent: Id;
  model: string;
  startedAt: Ms;
  endedAt: Ms | null;
  tokens: number;
  cost: number;
  outcome: string | null;
  note: string;
  agentVersion?: string;
  skills?: HistorySkill[];
  summary?: string;
  artefacts?: Artefact[];
}

export interface LogEntry {
  at: Ms;
  who: Id;
  text: string;
}
export interface Diff {
  plus: number;
  minus: number;
  files: number;
}
export interface Tests {
  passed: number;
  failed: number;
  added: number;
}
export interface PullRequest {
  number: number;
  branch: string;
  checks: "pending" | "green" | "red";
  state: "open" | "merged" | "draft" | "closed";
  tag: string | null;
  title?: string;
  body?: string;
  reviewers?: Id[];
  mergeStrategy?: "squash" | "merge" | "rebase";
  mergedAt?: Ms;
  mergedBy?: Id;
  releaseNotes?: string;
  releasedAt?: Ms;
}
export interface WoKill {
  by: Id;
  at: Ms;
  reason: string;
  scope: string;
  mode?: "hold" | "cancel";
  prev: { state: string; station: number; bay: string | null; bayFrom: string | null };
}

export interface ConvMessage {
  from: Id;
  at: Ms;
  text: string;
  qid?: string;
  chips?: string[];
  /** Written by Gantry's scripted questionnaire, not by an agent. */
  scripted?: boolean;
}
export interface ConvQuestion {
  id: string;
  field: string;
  text: string;
  chips: string[];
}
export interface ConvMiss {
  id: string;
  text: string;
  resolved: boolean;
}
export interface ConvDecision {
  text: string;
  by: Id;
  at: Ms;
}
export interface ConvRaised {
  station: string;
  text: string;
  at: Ms;
  answered: boolean;
  answer?: string;
}
export interface Conversation {
  messages: ConvMessage[];
  qi: number;
  answers: Record<string, string>;
  misses: ConvMiss[];
  decisions: ConvDecision[];
  awaiting: string;
  done: boolean;
  raised: ConvRaised[];
  questions: ConvQuestion[];
}

export interface Brief {
  goal: string;
  scopeIn: string[];
  scopeOut: string[];
  ac: string[];
  risks: string[];
  open: string[];
  decisions: string[];
  estimate: string;
  route: string[];
  children: string[];
}
export interface BriefVersion {
  v: number;
  at: Ms;
  by: Id;
  note: string;
  brief: Brief;
}

export interface WoRequest {
  title: string;
  text: string;
  source: string;
  by: Id;
  via: string | null;
  at: Ms;
  attachments: unknown[];
  requestedCls: string | null;
}

export interface Commit {
  hash: string;
  message: string;
  agent: Id;
  station: string;
  at: Ms;
  files: string[];
  step: string;
}
export type OutcomeKind = "healthy" | "revert" | "incident";
export interface Outcome {
  kind: OutcomeKind;
  at: Ms;
  text: string;
  severity?: "low" | "medium" | "high";
  by?: Id;
}
export interface ReviewComment {
  by: Id;
  at: Ms;
  file: string;
  line: number;
  text: string;
  resolved: boolean;
  resolution: string;
}
export interface WoCheck {
  name: string;
  status: string;
  at: Ms;
}
export interface Sendback {
  from: string;
  to: string;
  note: string;
  at: Ms;
  by: Id;
}
export interface CriterionTest {
  name: string;
  result: string;
  ms: number;
}
export interface Criterion {
  id: string;
  text: string;
  status: string;
  tests: CriterionTest[];
}
export interface PlanStep {
  id: string;
  text: string;
  files: string[];
  ac: string[];
}
export interface DiffLine {
  t: " " | "+" | "-";
  s: string;
}
export interface WoFile {
  path: string;
  from: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  plus: number;
  minus: number;
  step: string;
  ac: string[];
  protected: boolean;
  preview: DiffLine[];
  state: "planned" | "committed" | "merged";
}
export interface Guardrail {
  maxDiff: number;
  size: number;
  over: boolean;
  protectedTouched: string[];
}

export type WorkOrderState = WoStateId;
export type WoBayId = string;

/** Why a work order waits before a full station (the counts are those when it began to wait; `wipStatus` has the live ones). */
export interface WipWait { station: Id; since: Ms; live: number; limit: number }

export interface WorkOrder {
  id: Id;
  project: Id;
  repo: Id;
  title: string;
  description: string;
  attachments: unknown[];
  cls: string;
  clsConfidence: number;
  clsRationale: string;
  clsSuggested: string;
  clsOverridden: { by: Id; at: Ms; from: string; reason: string } | null;
  requestedCls: string | null;
  priority: Priority;
  source: string;
  requestedBy: Id;
  createdAt: Ms;
  /** Index into the catalogue's station list (position). */
  station: number;
  state: WorkOrderState;
  bay: WoBayId | null;
  bayReason: string;
  bayFrom: string | null;
  bayAt?: Ms;
  progress: number;
  /** Coding slot number (1-based) held at Build, else null. */
  slot: number | null;
  history: HistoryEntry[];
  gates: Record<string, GateInstance>;
  log: LogEntry[];
  diff: Diff;
  tests: Tests;
  pr: PullRequest | null;
  blockReason: string | null;
  failReason: string | null;
  /** Why the work order sits in the Needs a person bay: "failed" when the station failed or lost its run repeatedly, "merge" when the approved merge could not happen (so Retry or Retry merge applies). */
  bayCause?: string;
  /** Set while the work order has finished its station and waits for the next one, which is at its WIP limit. It stays where it is and goes in when a place frees. */
  wipWait?: WipWait | null;
  /** "start" when the failed run never started (workspace seeding, the launcher, no model). */
  failPhase?: string;
  doneAt: Ms | null;
  killed: WoKill | null;
  parent: Id | null;
  children: Id[];
  risk: "normal" | "high" | (string & {});
  paths: string[];
  slaDue: Ms;
  conv: Conversation;
  brief: Brief;
  /* lifecycle record (G.lc) */
  request?: WoRequest;
  briefVersions?: BriefVersion[];
  commits?: Commit[];
  outcomes?: Outcome[];
  reviewComments?: ReviewComment[];
  checks?: WoCheck[];
  sendbacks?: Sendback[];
  bayTime?: unknown[];
  criteria?: Criterion[];
  plan?: PlanStep[];
  files?: WoFile[];
  guardrail?: Guardrail;
  security?: { scanner: string; findings: number; severity: string; note: string };
  coverage?: { before: number; after: number; changedLines: number };
  split?: boolean;
  heldByKill?: boolean;
  outcomeOverride?: Outcome;
  submittedBy?: Id;
  sourceIntegration?: Id;
}

/* ------------------------------------------------------------------ agents, skills ------ */

export type Autonomy = "auto" | "gate" | "suggest";
export interface AgentTools {
  readRepo: boolean;
  writeBranch: boolean;
  runTests: boolean;
  openPR: boolean;
  merge: boolean;
  postSlack: boolean;
  sendEmail: boolean;
  readSecrets: boolean;
}
export interface AgentVersion {
  v: string;
  at: Ms;
  note: string;
  diff: string;
  suiteScore: number;
  live: boolean;
  rc: boolean;
  snapshot: unknown;
}
export interface Agent {
  id: Id;
  name: string;
  station: string | null;
  model: string;
  fallbacks: string[];
  version: string;
  status: string;
  autonomy: Autonomy;
  tools: AgentTools;
  skills: Id[];
  mcp: Id[];
  stations: string[];
  projects: "all" | Id[];
  budget: number;
  guardrails: { paths: string[]; maxDiff: number };
  suite: Id;
  instructions: string;
  overrides: Record<string, { model?: string; autonomy?: Autonomy; budget?: number }>;
  versions: AgentVersion[];
  spark: number[];
  spend7d: number;
  initials: string;
  evalScore: number;
  /** Loaded with the built-in starter kit. */
  builtin?: boolean;
  /** The skills the version on the floor runs with, each at its pinned version label ("" when none is recorded). `skills` is the draft attachments, which can differ until a new version goes live. */
  liveSkills?: Array<{ id: Id; version: string }>;
}

export interface SkillVersion {
  v: string;
  at: Ms;
  by: Id;
  note: string;
}
export interface Skill {
  id: Id;
  name: string;
  desc: string;
  when: string;
  owner: Id;
  body: string;
  resources: string[];
  version: string;
  projects: "all" | Id[];
  versions: SkillVersion[];
  coverage: { suite: Id | null; cases: number; pass: number };
  /** Loaded with the built-in starter kit. */
  builtin?: boolean;
}

export interface AgentInstructions {
  base: string;
  baseVersion: number;
}

/* ------------------------------------------------------------------ vendors, models ----- */

export interface Model {
  id: Id;
  name: string;
  enabled: boolean;
  context: number;
  inPrice: number;
  outPrice: number;
  /** The vendor serving this model (set by the API reads). */
  vendor?: Id;
  tier?: string;
  /** Added by a person rather than shipped in the catalogue. */
  custom?: boolean;
  /** Models with the same canonical id are the same model on different vendors (same-model fallback, spec 10.4). */
  canonical?: string;
  /** Cache prices per million tokens when set; the default ratios of the input price apply otherwise. */
  cacheRead?: number;
  cacheWrite?: number;
  /** Found by listing the vendor's models (spec 10.4 Vendor templates), not typed in. */
  discovered?: boolean;
  /** Discovered, but the catalogue had no price for it: enter one before switching it on. */
  needsPrice?: boolean;
  /** False when the gateway cannot call this model's vendor yet; it cannot be switched on. */
  invocable?: boolean;
}
export type VendorHealth = "healthy" | "degraded" | "offline";
export interface Vendor {
  id: Id;
  name: string;
  product: string;
  connected: boolean;
  health: VendorHealth;
  latency: number;
  mtd: number;
  budget: number;
  keyMask: string;
  region: string;
  endpoint: string;
  residency: string;
  models: Model[];
  /** A vendor added by a person: base URL and key. Not qualified for a station until that station's suite passed on it (spec 10.4). */
  custom?: boolean;
  /** Data-retention mode the vendor offers: zero, 30d or standard. */
  retention?: string;
  /** Stations whose eval suite passed on this vendor. Only meaningful for custom vendors. */
  qualified?: Record<string, { suite: string; run: string; at: string }>;
  version?: number;
  /** The template the vendor was added from (anthropic, bedrock, ...); its models can be listed again. */
  template?: string;
  /** When its models were last listed from the vendor's API (ISO). */
  discoveredAt?: string;
}
export interface RoutingRule {
  id: string;
  tag: string;
  use: Id;
  region: string;
  alt: string;
  note: string;
}
/** Routing policy of one project (spec 10.4): its own default and overrides, and the vendors, regions and retention modes it allows. */
export interface ProjectRouting {
  defaultModel?: Id;
  overrides?: Record<string, Id>;
  classOverrides?: Record<string, Id>;
  allowedVendors?: Id[];
  allowedRegions?: string[];
  allowedRetention?: string[];
  /** The project opts in to falling back to a different model. Needs the factory switch as well. */
  crossModelFallback?: boolean;
}
export interface Routing {
  defaultModel: Id;
  /** Station id -> model. */
  overrides: Record<string, Id>;
  fallback: Id[];
  rules: RoutingRule[];
  /** Work-order class -> model. */
  classOverrides?: Record<string, Id>;
  projects?: Record<string, ProjectRouting>;
  /** Factory switch for falling back to a different model. Off in a new install. */
  crossModelFallback?: boolean;
  /** The routing version this is (read only). */
  version?: number;
}

/* ------------------------------------------------------------------ evals --------------- */

/** A deterministic or advisory check recorded for an eval result. */
export interface EvalCheck {
  kind: string;
  label: string;
  /** null for an advisory check: it never counts (spec 13.2). */
  pass: boolean | null;
  advisory?: boolean;
  detail?: string;
}
export interface EvalCase {
  id: string;
  name: string;
  by?: Id;
  added?: Ms;
  /** What the agent is asked to do. */
  task?: string;
  /** The snapshot the task is pinned to. */
  repo?: Id | null;
  commit?: string | null;
  golden?: boolean;
  /** The person's own words on what a passing answer must do (advisory; never given to the agent). */
  checks?: string;
  /** The deterministic checks that decide the case. */
  rules?: Array<{ kind: string; [k: string]: unknown }>;
  skill?: string;
  cls?: string;
}
export interface Suite {
  id: Id;
  name: string;
  station: string;
  threshold: number;
  agent: Id;
  cases: EvalCase[];
  /** The run in progress, if any. */
  running?: string | null;
  version?: number;
  /** Loaded with the built-in starter kit. */
  builtin?: boolean;
}
export interface EvalResult {
  caseId: string;
  pass: boolean;
  reason: string;
  ms: number;
  /** When a task was run more than once: how many runs, and how many passed. */
  repeats?: number;
  passes?: number;
  /** Model-graded opinions: advisory only. */
  advisory?: EvalCheck[];
  /** Runs that ended without a graded result (never started, lost, stopped). */
  errors?: string[];
}
export interface EvalRun {
  id: string;
  suite: Id;
  agent: Id;
  version: string;
  model: string;
  at: Ms;
  score: number;
  results: EvalResult[];
  by: Id;
  cost: number;
  /** queued, running, completed, failed or cancelled. */
  status?: string;
  /** Tasks graded, tasks passed and the 95% range of the pass share (spec 13.2: a score is reported with its task count and a range). */
  count?: number;
  passed?: number;
  range?: [number, number];
  repeats?: number;
  /** Items finished out of items planned, while a run is going. */
  done?: number;
  total?: number;
  finishedAt?: Ms | null;
  /** Run on a model other than the version's pinned one: says how that model does, and does not qualify the version. */
  override?: boolean;
  vendor?: string | null;
  seeded?: boolean;
}
export interface Scorecard {
  taskSuccess: number;
  firstPass: number;
  testPass: number;
  rework: number;
  costPerWO: number;
  minutesPerStation: number;
  gateRejections: number;
  overrideRate: number;
  /** `n` is finished attempts per week: a week with none has no point to draw. */
  trend: { success: number[]; cost: number[]; n?: number[] };
  /** What the figures rest on: attempts, gate decisions and test results in the last 7 days, and the work orders behind them. */
  counts?: { attempts: number; decisions: number; workOrders: number; tests?: number };
}
export interface ClassStats {
  count: number;
  success: number;
  cycleH: number;
  rework: number;
}
export interface EvalExtra {
  heat: Record<Id, Record<Id, number | null>>;
  confusion: Record<string, Record<string, number>>;
  perClass: Record<string, ClassStats>;
  overrideRate: number;
  onboarding: { attempts: number; ready: number; successRate: number; medianDays: number; p90Days: number; failedReasons: Array<[string, number]> };
  gateRejections: Array<[string, number]>;
  humanOverride: Record<string, number>;
  /** Repos by onboarding stage. */
  onboardingStages?: Record<string, number>;
  counts?: { workOrders: number; classified: number; decisions: number; attempts: number };
}

/* ------------------------------------------------------------------ MCP ----------------- */

export interface McpTool {
  name: string;
  /** The admin-set class (spec 12.4). */
  write: boolean;
  allowed: boolean;
  /** The server's own suggestion of the class; only a hint. */
  hint?: "read" | "write" | null;
  description?: string;
  /** Hash of the approved definition. */
  hash?: string;
  /** A rediscovery found a different definition: the server stays disabled until an admin re-approves it. */
  changed?: boolean;
}
export type McpHealth = "healthy" | "degraded" | "failing" | "offline" | (string & {});
export interface McpServer {
  id: Id;
  name: string;
  transport: "http" | "sse" | "stdio" | (string & {});
  url: string;
  auth: string;
  authMask: string;
  health: McpHealth;
  sensitivity: string;
  writeGate: boolean;
  tools: McpTool[];
  /** Registry fields of the real MCP gateway (spec 12.4); the legacy seed does not carry them. */
  authMode?: "none" | "bearer" | "header";
  authHeader?: string | null;
  protocolRevision?: string;
  enabled?: boolean;
  disabledReason?: string | null;
  /** The address or transport changed and its tools were not approved again; it cannot be switched on until they are. */
  needsReapproval?: boolean;
  healthDetail?: string | null;
  discoveredAt?: Ms | null;
  version?: number;
  projects: "all" | Id[];
  repos: "all" | Id[];
  agents: "all" | Id[];
  stations: "all" | string[];
  classes?: "all" | string[] | null;
}
export interface McpUsage {
  at: Ms;
  server: Id;
  tool: string;
  agent: Id;
  project: Id;
  outcome: "ok" | "error" | "gated" | "denied" | "allowed" | (string & {});
  ms: number;
  id?: number;
  wo?: Id | null;
  station?: string | null;
  argsHash?: string | null;
  reason?: string | null;
}

/* ------------------------------------------------------------------ integrations -------- */

export interface IntegrationField {
  key: string;
  label: string;
  type: "text" | "url" | "secret" | "bool" | "select" | (string & {});
  required: boolean;
  placeholder?: string;
  options?: string[];
}
export interface IntegrationType {
  id: Id;
  name: string;
  category: string;
  icon: string;
  auth: string;
  payload: string;
  builtIn: boolean;
  source?: boolean;
  destination?: boolean;
  targetLabel?: string;
  fields: IntegrationField[];
  events: string[];
  actions: string[];
  custom?: boolean;
  createdBy?: Id;
  createdAt?: Ms;
  /** False for types the catalogue lists but this version cannot connect (spec 12.1); `unavailableReason` says why. */
  available?: boolean;
  unavailableReason?: string;
  /** Custom types: the templated HTTP request sent for each notification (spec 12.1). */
  httpTemplate?: { method: "POST" | "PUT"; body: string; contentType: string };
}
export interface IntegrationInstance {
  id: Id;
  type: Id;
  name: string;
  config: Record<string, string | boolean | undefined>;
  secretMask: string;
  /** "unknown" means the connection was never tested, or its settings changed since (shown as "Not tested yet"). */
  status: "healthy" | "failing" | "offline" | "unknown" | (string & {});
  connected: boolean;
  projects: "all" | Id[];
  lastSync: Ms;
  createdBy: Id;
  createdAt: Ms;
  available?: Array<{ repo: string; lang: string }>;
  targetId?: string;
  /** Result of the last connection test (real call), when one ran. */
  lastTest?: { at: Ms; ok: boolean; by: Id; lines?: string[]; ms?: number };
  version?: number;
}
export interface WebhookEndpoint {
  id: string;
  url: string;
  secretMask: string;
  status: string;
}
/** Legacy per-channel connection summary (`state.integrations`). */
export interface ChannelConnection {
  connected: boolean;
  lastSync: Ms;
  status: string;
  [extra: string]: unknown;
}
export type Integrations = Record<string, ChannelConnection>;

export interface Delivery {
  id: string;
  at: Ms;
  project: Id | null;
  event: string;
  channel: Channel;
  target: string;
  integration?: Id | null;
  status: "delivered" | "failed" | (string & {});
  attempts: number;
  error: string;
  wo?: Id;
  route?: string;
  override?: string | null;
  repo?: Id | null;
  test?: boolean;
  /** pending until the outbox sends it; failed is retrying; dead is out of attempts. */
  state?: "pending" | "sent" | "failed" | "dead";
  retriedAt?: Ms;
}
export interface CardTemplate {
  id: string;
  name: string;
  actions: string[];
  kind?: string;
  fields?: string[];
  integration?: Id | null;
  project?: Id | null;
  by?: Id;
  at?: Ms;
  version?: number;
}

/* ------------------------------------------------------------------ api keys, triggers -- */

export interface ApiKey {
  id: Id;
  name: string;
  prefix: string;
  project: Id;
  actions: string[];
  created: Ms;
  lastUsed: Ms | null;
  revoked: boolean;
  by: Id;
  /** When the key stops working (null: never). */
  expires?: Ms | null;
  expired?: boolean;
  revokedAt?: Ms;
  revokedBy?: Id;
}
export interface ApiConfig {
  rateLimit: number;
  burst: number;
  idempotencyHours: number;
  webhookSigning: string;
  /** Master switch for every trigger (spec 15.3): off in a new install. */
  triggersEnabled?: boolean;
  version?: number;
}
export interface RequestLogEntry {
  at: Ms;
  key: Id;
  method: string;
  path: string;
  status: number;
  ms: number;
}
export interface TriggerRun {
  at: Ms;
  /** created, held (a proposal waits for a person), deduped, limited, refused, skipped. */
  outcome: "created" | "deduped" | "held" | "limited" | "refused" | "skipped" | (string & {});
  wo: Id;
  source: string;
  id?: string;
  /** What decided it, in a sentence. */
  msg?: string;
  /** The held proposal this run made (spec 11.7). */
  proposal?: string | null;
  /** Gantry identity the work was attributed to, when the source user mapped to one. */
  person?: Id | null;
  simulated?: boolean;
}
/** Work a trigger holds for a person to release (spec 11.7): the acting source user has no Gantry identity allowed to submit, or the trigger always asks. */
export interface TriggerProposal {
  id: string;
  trigger: Id;
  project: Id;
  repo: Id | null;
  title: string;
  description: string;
  cls: string | null;
  priority: string | null;
  source: string;
  actor: string | null;
  reason: string;
  status: "held" | "released" | "declined";
  wo: Id | null;
  at: Ms;
  decidedBy: Id | null;
  decidedAt: Ms | null;
  note: string;
}
export interface TriggerLimits {
  /** Work orders or proposals one trigger may make in an hour. */
  perHour: number;
  /** ... and in 24 hours (the trigger's budget). */
  perDay: number;
}
export type TriggerType = "issue" | "comment" | "schedule" | "ci" | (string & {});
export interface Trigger {
  id: Id;
  project: Id;
  type: TriggerType;
  name: string;
  enabled: boolean;
  label?: string;
  labelMap?: Record<string, string>;
  command?: string;
  schedule?: string;
  cls?: string;
  who: string;
  reply: string;
  dedupe: boolean;
  repos: string;
  runs: TriggerRun[];
  source?: string;
  /** Title of the scheduled work (schedule triggers). */
  title?: string;
  /** Repo a schedule or build trigger files work in (default: the project's first ready repo). */
  repo?: Id;
  priority?: string;
  limits?: TriggerLimits;
  version?: number;
  /** Next scheduled run (schedule triggers that are on). */
  nextRun?: Ms | null;
  /** Proposals waiting for a person. */
  held?: number;
  createdBy?: Id;
}

/* ------------------------------------------------------------------ access -------------- */

export interface PolicyWhere {
  projects?: Id[];
  freeze?: boolean;
  regulated?: boolean;
}
export interface PolicyWhen {
  /** 0 = Sunday ... 6 = Saturday, IST. */
  days: number[];
  from: string;
  to: string;
}
export type PolicyEffect = "allow" | "deny";
export interface Policy {
  id: string;
  name: string;
  effect: PolicyEffect;
  enabled: boolean;
  /** Role ids, or "*" (anyone) / "agents". */
  roles: string[];
  actions: string[];
  where: PolicyWhere;
  when: PolicyWhen | null;
  oncallOnly: boolean;
  extend?: boolean;
}
export interface Freeze {
  id: string;
  name: string;
  repos: "all" | Id[];
  from: Ms;
  to: Ms;
  by: Id;
}

export interface SsoSettings {
  provider: string;
  domain: string;
  enforced: boolean;
  entity: string;
}
export interface SecuritySettings {
  sso: SsoSettings;
  mfa: { policy: string; methods: string[] };
  sessionHours: number;
  idleMin: number;
  domains: string[];
  ipAllow: string[];
  restoreFactoryNeedsTwo: boolean;
  /** Kill needs a sign-in within the step-up window (default on). Restore always does. */
  killNeedsStepUp?: boolean;
  /** Minutes a sign-in counts as fresh for step-up operations (spec 14.1). Default 15, allowed 5 to 60. */
  stepUpWindowMinutes?: number;
  githubLogin: boolean;
  /** Hosts station agents may read through governed web research (patterns like docs.example.com or *.example.org). Empty: no web research. */
  researchHosts?: string[];
  /** Most a person may spend on chats (the Console and side threads with agents) per rolling 24 hours, in dollars. Null: no cap beyond the model budgets. */
  chatCapUsdPerDay?: number | null;
}
export interface Session {
  id: Id;
  person: Id;
  method: string;
  device: string;
  ip: string;
  started: Ms;
  lastSeen: Ms;
  revoked: boolean;
  current?: boolean;
  restored?: boolean;
  at?: Ms;
}
export interface SignIn {
  at: Ms;
  person: Id | null;
  email: string;
  method: string;
  outcome: "success" | "failure" | (string & {});
  reason: string;
  ip: string;
  device: string;
}

/* ------------------------------------------------------------------ audit, events ------- */

export type AuditCategory = "auth" | "access" | "flow" | "onboarding" | "approvals" | "config" | "integrations" | "api" | "agents" | "kill";
export type AuditOutcome = "ok" | "warn" | "denied" | "failed" | "regression" | "blocked" | (string & {});
export interface AuditEntry {
  id: number;
  at: Ms;
  actor: Id;
  action: string;
  target: string;
  where: string;
  project: Id | null;
  category: AuditCategory | (string & {});
  outcome: AuditOutcome;
  via: string;
  before: string | null;
  after: string | null;
  entity: { type: string; id: string } | null;
}

export interface EventEntry {
  id: number;
  at: Ms;
  type: string;
  project?: Id;
  wo?: Id;
  repo?: Id;
  station?: string;
  gate?: string;
  bay?: string | null;
  scope?: string;
  by?: Id | null;
  mode?: string;
  trust?: number | null;
  from?: number | string | null;
  to?: number | string | null;
  cell?: string;
  text?: string;
}

/* ------------------------------------------------------------------ trust, learning ----- */

export interface TrustLevelDef {
  level: number;
  code: string;
  name: string;
  desc: string;
}
export interface TrustCriteria {
  cleanRuns: number;
  evalMin: number;
  reworkMax: number;
  incidentsMax: number;
  windowD: number;
}
export interface TrustCeiling {
  id: string;
  text: string;
  when: { regulated?: boolean; cls?: string; project?: Id; gate?: string };
  max: number;
  enabled: boolean;
  /** For If-Match. */
  version?: number;
}
export interface TrustHistoryEntry {
  at: Ms;
  from: number | null;
  to: number;
  by: Id;
  kind: "seed" | "grant" | "demote" | (string & {});
  reason: string;
  cause?: { type: string; wo?: Id } | null;
}
export interface TrustCell {
  id: string;
  agent: Id;
  cls: string;
  project: Id;
  repo: Id | null;
  level: number;
  since: Ms;
  cleanRuns: number;
  history: TrustHistoryEntry[];
  /** Computed by the server (GET /trust/cells), so the screen shows counts and criteria without re-deriving them. */
  rev?: number;
  virtual?: boolean;
  gate?: string | null;
  evidence?: { runs: number; cleanRuns: number; evalScore: number; rework: number; incidents: number; incidentWos: string[] };
  meets?: { ok: boolean; next: number | null; missing: string[] };
  ceiling?: { max: number; ids: string[] };
  /** What the cell runs at: the grant capped by ceilings, and by L1 while levels above L1 are switched off. */
  effective?: number;
  projection?: number;
  pending?: string | null;
}
export interface TrustProposal {
  id: string;
  cell: string;
  from: number;
  to: number;
  at: Ms;
  status: "pending" | "accepted" | "declined" | "withdrawn" | (string & {});
  by: Id | null;
  decidedAt: Ms | null;
  reason: string;
  evidence: { cleanRuns: number; evalScore: number; note: string };
  savedPerWeek: number;
  manual?: boolean;
}
export interface Trust {
  sampleRate: number;
  criteria: Record<string, TrustCriteria>;
  ceilings: TrustCeiling[];
  cells: TrustCell[];
  proposals: TrustProposal[];
  nextProposal: number;
  seededAt: Ms;
  /** Runtime switch (spec 15.3): off in a new install. While off, nothing above L1 acts and levels above L1 cannot be granted. */
  levelsAboveL1?: boolean;
  criteriaVersion?: number;
  /** Below this many reviewed runs a rate is "insufficient data". */
  minRuns?: number;
  soakDays?: number;
  /** L4 is not grantable in this version. */
  maxGrantable?: number;
  /** Per project: gate decisions in the last 7 days and how many ran under trust. */
  coverage?: Record<string, { total: number; auto: number }>;
}

export type LearningSignal = "rejection" | "override" | "revert" | "miss" | "sendback" | "incident" | "regression";
export interface LearningFinding {
  id: string;
  title: string;
  signal: LearningSignal;
  agent: Id;
  project: Id | null;
  evidence: string[];
  count: number;
  firstAt: Ms;
  lastAt: Ms;
  status: "open" | "addressed" | (string & {});
  rev?: number;
}
export interface LearningProposal {
  id: string;
  finding: string;
  kind: "skill" | "eval" | "guideline" | "guardrail" | "approver" | "route" | (string & {});
  title: string;
  owner: Id;
  status: "proposed" | "accepted" | "verified" | "declined" | (string & {});
  at: Ms;
  expected: string;
  change: Record<string, unknown>;
  history: Array<{ at: Ms; by: Id; text: string }>;
  reason?: string;
  rev?: number;
  /** Declared before the change (spec 13.4): at most `target` signals of the finding's kind in `windowDays` after it is applied. */
  metric?: { signal: string; project: string | null; agent: string | null; target: number };
  windowDays?: number;
  baseline?: { count: number; from: Ms; to: Ms } | null;
  appliedAt?: Ms | null;
  appliedBy?: Id | null;
  /** How the change is undone (available: false when it cannot be, with the reason in the summary). */
  rollback?: { summary: string; available: boolean } | null;
  verification?: { measured: number; target: number; baseline: number | null; at: Ms; by: Id } | null;
}
export interface Learning {
  findings: LearningFinding[];
  proposals: LearningProposal[];
  next: { finding: number; proposal: number };
}

/* ------------------------------------------------------------------ console, prefs ------ */

export interface ConsoleState {
  messages: unknown[];
  pinned: Id[];
}
export interface BoardFilters {
  cls: string;
  repo: string;
  assignee: string;
  prio: string;
}
export interface Prefs {
  project: Id;
  theme: string;
  paused: boolean;
  floorView: string;
  boardSwim: string;
  boardFilters: BoardFilters;
  collapsedBays: boolean;
  activeClass: string | null;
  navCollapsed: Record<string, boolean>;
  navRail: boolean;
  palettePinned: string[];
  paletteRecent: string[];
  record: unknown;
  replay: unknown;
  portfolio?: unknown;
}
export interface WoTrackEntry {
  state: WorkOrderState;
  bay: string | null;
}

/* ------------------------------------------------------------------ the whole tree ------ */

/** The legacy `G.store` state tree. The API serves each slice under its own name. */
export interface GantryState {
  org: Org;
  factory: FactoryState;
  teams: Team[];
  people: Person[];
  projects: Project[];
  repos: Repo[];
  agents: Agent[];
  skills: Skill[];
  mcp: McpServer[];
  mcpUsage: McpUsage[];
  vendors: Vendor[];
  routing: Routing;
  templates: Template[];
  workOrders: WorkOrder[];
  nextWO: number;
  nextPR: number;
  integrations: Integrations;
  deliveries: Delivery[];
  nextDelivery: number;
  apiKeys: ApiKey[];
  apiConfig: ApiConfig;
  requestLog: RequestLogEntry[];
  triggers: Trigger[];
  matrix: Matrix;
  policies: Policy[];
  freezes: Freeze[];
  security: SecuritySettings;
  sessions: Session[];
  signins: SignIn[];
  guidelines: OrgGuidelines;
  instructions: AgentInstructions;
  suites: Suite[];
  evalRuns: EvalRun[];
  nextRun: number;
  scorecards: Record<Id, Scorecard>;
  evalExtra: EvalExtra;
  audit: AuditEntry[];
  nextAudit: number;
  console: ConsoleState;
  session: Session | null;
  prefs: Prefs;
  integrationTypes: IntegrationType[];
  integrationInstances: IntegrationInstance[];
  cardTemplates: CardTemplate[];
  trust: Trust;
  learning: Learning;
  events: EventEntry[];
  nextEvent: number;
  woTrack: Record<Id, WoTrackEntry>;
}

/** What `devSeed()` returns: the state tree plus the catalogue entries the seed added. */
export interface DevSeed {
  state: GantryState;
  catalog: Catalog;
  integrationCategories: Array<{ id: string; name: string }>;
  notifyEvents: Array<{ id: string; name: string }>;
}

/* ------------------------------------------------------------------ decisions ----------- */

export type RuleKind = "matrix" | "policy" | "policy-missing" | "approver" | "stop" | "invariant" | (string & {});
export interface DecisionRule {
  kind: RuleKind;
  id: string;
  name?: string;
  freeze?: string;
  /** Step-up refusals: the sign-in window in seconds and how long ago the person signed in. */
  windowSec?: number;
  signedInSecAgo?: number | null;
  action?: string | null;
}
export interface Decision {
  allowed: boolean;
  reason: string;
  rule: DecisionRule;
  needs: string;
  /**
   * A Factory Admin break-glass (owner decision 2026-11-19). On a denial: only an override with a reason would allow it (`needs` is "override_reason").
   * On an allow: the override was used, so the caller must record the reason in the audit.
   */
  override?: boolean;
  /** Which stop the override passes: a release freeze or an andon halt. */
  overrideKind?: "freeze" | "halt";
}
