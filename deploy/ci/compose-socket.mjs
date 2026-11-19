#!/usr/bin/env node
// Compose lint (CI): the Docker socket is root on the host. Only the socket proxies (services named gantry-sockproxy*) may mount it or join the
// host's docker group; every other service must reach Docker through a proxy. Reads the normalised output of `docker compose config --format json`
// from stdin (--stdin) or runs it for the files given (default: deploy/compose.yml, and with the production override).
//   node deploy/ci/compose-socket.mjs                       # checks the development and production configurations
//   docker compose ... config --format json | node deploy/ci/compose-socket.mjs --stdin
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PROXY = /^gantry-sockproxy(-[a-z0-9]+)?$/;
const SOCK = /docker\.sock|\/var\/run\/docker|docker_host|DOCKER_SOCKET/i;

/** Returns the problems found in a compose configuration (an object as printed by `docker compose config --format json`). */
export function socketProblems(config) {
  const out = [];
  for (const [name, svc] of Object.entries(config.services ?? {})) {
    if (PROXY.test(name)) continue;
    for (const v of svc.volumes ?? []) {
      const src = typeof v === "string" ? v : `${v.source ?? ""}:${v.target ?? ""}`;
      if (SOCK.test(src)) out.push(`${name}: mounts the Docker socket (${src}); route it through gantry-sockproxy instead`);
    }
    if ((svc.group_add ?? []).length > 0) out.push(`${name}: group_add ${JSON.stringify(svc.group_add)} (the docker group is the socket); only the socket proxies may join it`);
    if (svc.privileged === true) out.push(`${name}: privileged`);
    if (["host"].includes(svc.network_mode) || ["host"].includes(svc.pid) || ["host"].includes(svc.ipc)) out.push(`${name}: shares a host namespace`);
  }
  return out;
}

function load(files, envFile) {
  const args = [...(envFile ? ["--env-file", envFile] : []), ...files.flatMap((f) => ["-f", f])];
  return JSON.parse(execFileSync("docker", ["compose", ...args, "config", "--format", "json"], { encoding: "utf8", env: { ...process.env, DOCKER_GID: process.env.DOCKER_GID ?? "999" } }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sets = process.argv.includes("--stdin")
    ? [JSON.parse(readFileSync(0, "utf8"))]
    : [load(["deploy/compose.yml"]), load(["deploy/compose.yml", "deploy/compose.prod.yml"], "deploy/prod.env.example")];
  const problems = sets.flatMap(socketProblems);
  if (problems.length) {
    console.error(problems.map((p) => `compose-socket: ${p}`).join("\n"));
    process.exit(1);
  }
  console.log("compose-socket: only the socket proxies hold the Docker socket");
}
