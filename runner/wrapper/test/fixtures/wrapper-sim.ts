// Stands in for PID 1 of a runner: takes the token the way main() does, then runs a "tool subprocess" that hunts for it as an agent's command could.
// argv[2] = token file, argv[3] = directory the hunt walks (the stand-in for /workspace).
import { execFileSync } from "node:child_process";
import { readEnv } from "../../src/env.js";
import { takeToken } from "../../src/token.js";

const tok = await takeToken(process.argv[2]!);
if (!tok.ok) {
  console.log(JSON.stringify({ error: tok.error }));
  process.exit(2);
}
const env = readEnv(tok.value);
const hunt = `
  const fs = require("fs"), path = require("path");
  const T = fs.readFileSync(0, "utf8"), out = { where: [] };
  const read = (p) => { try { return fs.readFileSync(p).toString("latin1"); } catch { return ""; } };
  for (const p of ["/proc/" + process.ppid + "/environ", "/proc/" + process.ppid + "/cmdline", "/proc/self/environ", "/proc/self/cmdline", "/proc/1/environ", "/proc/1/cmdline"]) if (read(p).includes(T)) out.where.push(p);
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch {} for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (read(f).includes(T)) out.where.push(f); } };
  walk(process.argv[1]);
  console.log(JSON.stringify(out));
`;
const res = execFileSync(process.execPath, ["-e", hunt, process.argv[3]!], { encoding: "utf8", env: process.env, input: tok.value });
console.log(JSON.stringify({ token: tok.value, env: env.ok ? { runToken: env.value.runToken } : env, hunt: JSON.parse(res) }));
