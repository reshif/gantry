/**
 * The facts the GitHub broker (poll, publish) and the webhook processor deliver to the API (spec 8.11, 11.6).
 * One shape for all three sources: `POST /internal/v1/github/events` takes it, and `processGithubDelivery` builds it from a stored webhook payload.
 */
import { z } from "zod";

const sha = z.string().regex(/^[0-9a-f]{7,64}$/);
const when = z.string().datetime({ offset: true }).nullable().optional();
const bigId = z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform((v) => Number(v)).nullable().optional();

export const PullRequestFact = z.object({
  number: z.number().int().positive(),
  githubId: bigId,
  title: z.string().max(1000),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean().default(false),
  headSha: sha.nullable(),
  baseBranch: z.string().max(300).nullable().optional(),
  headBranch: z.string().max(300).nullable().optional(),
  url: z.string().max(1000).nullable().optional(),
  mergedAt: when,
  mergeCommitSha: sha.nullable().optional(),
  labels: z.array(z.string().max(100)).max(100).default([]),
  author: z.string().max(200).nullable().optional(),
});
export type PullRequestFact = z.infer<typeof PullRequestFact>;

export const CheckFact = z.object({
  headSha: sha,
  name: z.string().min(1).max(300),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z.string().max(50).nullable().optional(),
  githubId: bigId,
  completedAt: when,
  /** The App that reported the check (the Gantry gate check must be ours). */
  appSlug: z.string().max(200).nullable().optional(),
});
export type CheckFact = z.infer<typeof CheckFact>;

export const ReviewFact = z.object({
  prNumber: z.number().int().positive(),
  githubId: bigId,
  reviewer: z.string().min(1).max(200),
  state: z.string().min(1).max(50),
  body: z.string().max(65536).default(""),
  submittedAt: when,
  commitId: sha.nullable().optional(),
});
export type ReviewFact = z.infer<typeof ReviewFact>;

export const IssueFact = z.object({
  number: z.number().int().positive(),
  title: z.string().max(1000),
  labels: z.array(z.string().max(100)).max(100).default([]),
  author: z.string().max(200).nullable().optional(),
  url: z.string().max(1000).nullable().optional(),
});
export type IssueFact = z.infer<typeof IssueFact>;

export const PublishedCommitFact = z.object({
  /** The commit id on GitHub (verified, created through the git data API). */
  sha,
  /** The id the runner made in its workspace. */
  localSha: sha,
  parents: z.array(sha).max(10),
  message: z.string().max(65536),
  author: z.string().max(200).nullable().optional(),
  committedAt: when,
  files: z.array(z.object({ path: z.string().max(2000), status: z.string().max(30), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() })).max(5000),
  /** Unified patch text; stored so the record survives GitHub dropping unreachable commits after a squash merge (spec 11.4). */
  patch: z.string().max(8 * 1024 * 1024).default(""),
  patchTruncated: z.boolean().default(false),
});
export type PublishedCommitFact = z.infer<typeof PublishedCommitFact>;

export const GithubFacts = z.object({
  source: z.enum(["poll", "hook", "publish"]),
  /** owner/name as GitHub spells it. */
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),
  pullRequests: z.array(PullRequestFact).max(500).default([]),
  checks: z.array(CheckFact).max(2000).default([]),
  reviews: z.array(ReviewFact).max(2000).default([]),
  issues: z.array(IssueFact).max(500).default([]),
  publish: z.object({
    attemptId: z.string().min(1).max(200),
    woId: z.string().min(1).max(200),
    branch: z.string().min(1).max(300),
    prNumber: z.number().int().positive().nullable().optional(),
    commits: z.array(PublishedCommitFact).max(500),
  }).optional(),
  /** The default branch and its tip as the poll saw them. Recorded as the repository's base commit, the commit new workspaces are seeded from (spec 4.3) until a work order has commits of its own. */
  base: z.object({ branch: z.string().min(1).max(300), sha: z.string().regex(/^[0-9a-f]{40}$/) }).optional(),
  /** Set when a webhook says a delivery was seen but its detail must come from the next poll. */
  hint: z.string().max(200).optional(),
});
export type GithubFacts = z.infer<typeof GithubFacts>;
