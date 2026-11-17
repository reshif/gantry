#!/usr/bin/env node
// Reads `docker buildx imagetools inspect --format '{{json .Provenance}}'` on stdin and exits 0 only when every SLSA provenance statement in it
// names <owner/name> (argv[2]) as its source repository, and there is at least one. Only the structured source fields count (SLSA v1
// buildDefinition.externalParameters.workflow.repository and resolvedDependencies[].uri; v0.2 invocation.configSource.uri and materials[].uri),
// and the URI must be the repository itself, optionally `.git`, `@ref` or `#ref`: `https://github.com/o/r-fork` or a field that merely mentions
// the repo does not match.
// Usage: provenance-names-repo.mjs owner/name < inspect-output
import { readFileSync } from "node:fs";

export function sourceUris(stmt) {
  const out = [];
  const bd = stmt?.buildDefinition;
  if (bd) {
    out.push(bd.externalParameters?.workflow?.repository);
    for (const d of bd.resolvedDependencies ?? []) out.push(d?.uri);
  }
  const inv = stmt?.invocation;
  if (inv) out.push(inv.configSource?.uri);
  for (const m of stmt?.materials ?? []) out.push(m?.uri);
  return out.filter((u) => typeof u === "string");
}

/** Finds every provenance statement (an object with buildDefinition, invocation or materials) anywhere in the inspect output. */
export function statements(node, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.buildDefinition || node.invocation || node.materials) {
    acc.push(node);
    return acc;
  }
  for (const v of Object.values(node)) statements(v, acc);
  return acc;
}

export function namesRepo(json, repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must look like owner/name");
  const esc = repo.toLowerCase().replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const re = new RegExp(`^(git\\+)?https://github\\.com/${esc}(\\.git)?([@#]\\S*)?$`);
  const all = statements(json);
  return all.length > 0 && all.every((s) => sourceUris(s).some((u) => re.test(u.toLowerCase())));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let json;
  try {
    json = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(1);
  }
  process.exit(namesRepo(json, process.argv[2] ?? "") ? 0 : 1);
}
