/* Work order record generator (G.lc). Builds the lifecycle record that #record and the traveler's
   Lifecycle tab render: request, criteria, plan, commits, files, diffs, tests per criterion, checks,
   PR and review comments, release and outcomes, plus a summary and artefacts for every station visit.
   Everything is derived deterministically from the work order (id, title, repo language, class), so the
   files in the plan are the files in the commits are the files in the PR. G.lc.sync(wo) is idempotent:
   seeding calls it for every work order and the simulation calls it whenever a work order moves. */
(function (G) {
  "use strict";
  var MIN = 60000;

  function hash(str) { var x = 2166136261; for (var i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x >>> 0; }
  function rngFor(seed) { var a = hash(seed); return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function hex(r, n) { var s = ""; for (var i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(r() * 16)]; return s; }
  var STOP = { add: 1, fix: 1, the: 1, for: 1, and: 1, with: 1, to: 1, on: 1, in: 1, of: 1, a: 1, an: 1, new: 1, show: 1, support: 1, expose: 1, emit: 1, upgrade: 1, bump: 1, patch: 1, retry: 1, rate: 1, limit: 1, split: 1, extract: 1, into: 1, from: 1, over: 1, after: 1, when: 1, by: 1, per: 1, all: 1 };
  function topic(wo) {
    var words = wo.title.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(function (w) { return w.length > 3 && !STOP[w]; });
    return (words[0] || "change").replace(/s$/, "");
  }
  function camel(t) { return t.charAt(0).toUpperCase() + t.slice(1); }

  var LAYOUT = {
    Go: function (t) { return { code: ["internal/" + t + "/" + t + ".go", "internal/" + t + "/handler.go", "internal/" + t + "/store.go"], test: ["internal/" + t + "/" + t + "_test.go"], docs: ["docs/CHANGELOG.md"], config: ["api/openapi.yaml"], migration: "migrations/0" + (40 + t.length) + "_" + t + ".sql", del: "internal/" + t + "/legacy.go" }; },
    TypeScript: function (t) { return { code: ["src/features/" + t + "/" + camel(t) + ".tsx", "src/features/" + t + "/use" + camel(t) + ".ts", "src/lib/api/" + t + ".ts"], test: ["src/features/" + t + "/" + camel(t) + ".test.tsx"], docs: ["CHANGELOG.md"], config: ["src/flags.ts"], migration: null, del: "src/features/" + t + "/old" + camel(t) + ".tsx" }; },
    Python: function (t) { return { code: [t + "/pipeline.py", t + "/features.py", t + "/schema.py"], test: ["tests/test_" + t + ".py"], docs: ["CHANGELOG.md"], config: ["config/" + t + ".yaml"], migration: "migrations/" + t + "_v2.sql", del: t + "/legacy.py" }; },
    Rust: function (t) { return { code: ["src/" + t + ".rs", "src/" + t + "/mod.rs", "src/config.rs"], test: ["tests/" + t + "_test.rs"], docs: ["CHANGELOG.md"], config: ["Cargo.toml"], migration: null, del: "src/" + t + "_old.rs" }; },
    Kotlin: function (t) { return { code: ["app/src/main/java/acme/" + t + "/" + camel(t) + "Screen.kt", "app/src/main/java/acme/" + t + "/" + camel(t) + "ViewModel.kt", "app/src/main/java/acme/" + t + "/" + camel(t) + "Repo.kt"], test: ["app/src/test/java/acme/" + t + "/" + camel(t) + "ViewModelTest.kt"], docs: ["CHANGELOG.md"], config: ["app/build.gradle.kts"], migration: null, del: "app/src/main/java/acme/" + t + "/Legacy" + camel(t) + ".kt" }; },
    Terraform: function (t) { return { code: ["modules/" + t + "/main.tf", "modules/" + t + "/variables.tf", "envs/staging/" + t + ".tf"], test: ["tests/" + t + ".tftest.hcl"], docs: ["CHANGELOG.md"], config: [".tflint.hcl"], migration: null, del: "envs/staging/" + t + "_old.tf" }; }
  };
  function layout(wo) {
    var repo = G.find && G.find.repo ? G.find.repo(wo.repo) : null;
    var lang = repo ? repo.lang : "Go";
    return (LAYOUT[lang] || LAYOUT.Go)(topic(wo));
  }
  function protectedHit(repo, path) {
    var pats = (repo && repo.config && repo.config.protectedPaths) || [];
    return pats.some(function (p) { var re = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*") + "$"); return re.test(path); });
  }

  function previewFor(path, status, t, r) {
    var ext = path.split(".").pop();
    var c = ext === "go" ? "//" : ext === "py" || ext === "yaml" || ext === "toml" || ext === "tf" || ext === "hcl" ? "#" : ext === "md" ? "" : ext === "sql" ? "--" : "//";
    if (ext === "md") return [{ t: " ", s: "## Unreleased" }, { t: "+", s: "- " + camel(t) + ": " + (status === "deleted" ? "removed legacy path" : "behaviour change, see work order") }];
    if (ext === "yml" || ext === "yaml") return [{ t: " ", s: "jobs:" }, { t: " ", s: "  test:" }, { t: "-", s: "    timeout-minutes: 10" }, { t: "+", s: "    timeout-minutes: 20" }, { t: "+", s: "    env: { " + t.toUpperCase() + "_CHECKS: \"on\" }" }];
    if (ext === "sql") return [{ t: "+", s: "ALTER TABLE " + t + "s ADD COLUMN idempotency_key text;" }, { t: "+", s: "CREATE UNIQUE INDEX " + t + "_idem ON " + t + "s (idempotency_key);" }];
    if (status === "deleted") return [{ t: "-", s: c + " Deprecated: replaced by the new " + t + " path" }, { t: "-", s: "func legacy" + camel(t) + "() {}" }];
    var tests = /test|spec|tftest/i.test(path);
    if (tests) return [{ t: " ", s: "" }, { t: "+", s: (ext === "py" ? "def test_" + t + "_happy_path():" : ext === "go" ? "func Test" + camel(t) + "HappyPath(t *testing.T) {" : "it(\"" + t + " happy path\", () => {") }, { t: "+", s: "    expect(" + t + "Result).toEqual(expected)" }, { t: "+", s: ext === "py" ? "" : "}" }];
    return [{ t: " ", s: c + " " + camel(t) }, { t: "-", s: "  total := sum(items)" }, { t: "+", s: "  total := roundHalfEven(sum(items), currency)" }, { t: "+", s: "  if err := validate" + camel(t) + "(req); err != nil { return err }" }];
  }

  function criteriaFor(wo) {
    var b = wo.brief || {};
    var list = [];
    (b.ac && b.ac.length ? b.ac : ["New behaviour covered by tests"]).forEach(function (t) { list.push(t); });
    list.push("Existing behaviour unchanged (regression suite green)");
    if (wo.cls === "hotfix" || wo.cls === "security") list.push("Fix verified in staging before release");
    else if (wo.cls === "feature" || wo.cls === "epic") list.push("Change documented in the changelog and API reference");
    else if (wo.cls === "docs") list.push("Reviewed by the owning team");
    return list.map(function (t, i) { return { id: "AC-" + (i + 1), text: t, status: "not tested", tests: [] }; });
  }

  /* base fields: request, criteria, plan, planned files. Safe to call any time. */
  function ensure(wo) {
    if (!wo.request) wo.request = { title: wo.title, text: wo.description, source: wo.source, by: wo.requestedBy, via: wo.submittedBy || null, at: wo.createdAt, attachments: (wo.attachments || []).slice(), requestedCls: wo.requestedCls || null };
    if (!wo.briefVersions) wo.briefVersions = [];
    if (!wo.commits) wo.commits = [];
    if (!wo.outcomes) wo.outcomes = [];
    if (!wo.reviewComments) wo.reviewComments = [];
    if (!wo.checks) wo.checks = [];
    if (!wo.sendbacks) wo.sendbacks = [];
    if (!wo.bayTime) wo.bayTime = [];
    var confirmed = wo.gates && wo.gates.G0G1 && wo.gates.G0G1.status === "passed";
    if (confirmed && !wo.briefVersions.length) {
      var a = wo.gates.G0G1.approvals[0] || { by: wo.requestedBy, at: wo.createdAt + 20 * MIN };
      wo.briefVersions.push({ v: 1, at: a.at, by: a.by, note: "Confirmed at G0+G1", brief: JSON.parse(JSON.stringify(wo.brief || {})) });
    }
    if (confirmed && !wo.criteria) wo.criteria = criteriaFor(wo);
    if (!wo.criteria) return wo;
    if (!wo.plan) {
      var L = layout(wo), r = rngFor(wo.id + ":plan"), t = topic(wo);
      var repo = G.find && G.find.repo ? G.find.repo(wo.repo) : null;
      var steps = [];
      var docOnly = wo.cls === "docs";
      if (docOnly) steps.push({ id: "P1", text: "Update the documentation for " + t, files: L.docs.concat(["docs/" + t + ".md"]), ac: ["AC-1"] });
      else {
        steps.push({ id: "P1", text: "Add a failing test that captures the requested behaviour", files: L.test.slice(), ac: ["AC-1"] });
        steps.push({ id: "P2", text: "Implement the change in the " + t + " module", files: L.code.slice(0, wo.cls === "chore" ? 1 : 2), ac: ["AC-1"] });
        if (wo.cls === "feature" || wo.cls === "epic" || wo.cls === "refactor") steps.push({ id: "P3", text: wo.cls === "refactor" ? "Remove the replaced code path" : "Wire the change into the API and configuration", files: wo.cls === "refactor" ? [L.del] : L.config.concat([L.code[2]]), ac: [wo.cls === "refactor" ? "AC-2" : "AC-1"] });
        if (L.migration && (wo.cls === "feature" || wo.cls === "bug") && r() < 0.5) steps.push({ id: "P" + (steps.length + 1), text: "Add a reversible migration", files: [L.migration], ac: ["AC-2"] });
        steps.push({ id: "P" + (steps.length + 1), text: "Update the changelog and docs", files: L.docs.slice(), ac: [wo.criteria.length > 2 ? "AC-3" : "AC-2"] });
      }
      if (wo.repo === "platform-infra" || (r() < 0.12 && wo.cls !== "docs")) steps[steps.length - 1].files.push(".github/workflows/ci.yml");
      wo.plan = steps;
      wo.files = [];
      steps.forEach(function (st) {
        st.files.forEach(function (path) {
          if (wo.files.some(function (f) { return f.path === path; })) return;
          var status = path === L.del ? "deleted" : path === L.migration || /test|tftest/.test(path) && r() < 0.6 || path.indexOf("docs/" + t) === 0 ? "added" : r() < 0.06 ? "renamed" : "modified";
          var plus = status === "deleted" ? 0 : /md$/.test(path) ? Math.round(3 + r() * 12) : /sql$/.test(path) ? Math.round(6 + r() * 10) : /yml$|yaml$|toml$|kts$/.test(path) ? Math.round(2 + r() * 14) : Math.round((/test/.test(path) ? 30 : 25) + r() * 70);
          var minus = status === "added" ? 0 : status === "deleted" ? Math.round(20 + r() * 60) : Math.round(r() * 30);
          wo.files.push({ path: path, from: status === "renamed" ? path.replace(/(\.\w+)$/, "_old$1") : null, status: status, plus: plus, minus: minus, step: st.id, ac: st.ac.slice(), protected: protectedHit(repo, path), preview: previewFor(path, status, t, r), state: "planned" });
        });
      });
    }
    return wo;
  }

  var SUMMARY = {
    intake: function (wo) { return "Classified as " + clsName(wo) + " at " + Math.round(wo.clsConfidence * 100) + "% confidence and ran the intake conversation (" + (wo.conv ? Object.keys(wo.conv.answers).length : 0) + " answers, " + (wo.conv ? wo.conv.misses.length : 0) + " misses found)."; },
    research: function (wo) { return "Read the " + topic(wo) + " code paths in " + wo.repo + ", the related tickets and the last 14 days of dashboards. Wrote a research note with " + (2 + hash(wo.id) % 3) + " findings and no blocking unknowns."; },
    spec: function (wo) { return "Turned the confirmed brief into a one-page spec with " + (wo.criteria ? wo.criteria.length : 2) + " acceptance criteria, an out-of-scope list and the affected owners from CODEOWNERS."; },
    design: function (wo) { return "Proposed the interface and data shape for " + topic(wo) + ", reusing existing components. Flagged one compatibility risk for review."; },
    plan: function (wo) { return "Planned " + (wo.plan ? wo.plan.length : 3) + " ordered steps touching " + (wo.files ? wo.files.length : 4) + " files, each tied to an acceptance criterion, with a rollback note."; },
    build: function (wo) { return "Implemented the plan in " + wo.commits.filter(function (c) { return c.station === "build"; }).length + " commits on " + (wo.pr ? wo.pr.branch : "a branch") + ": +" + sum(wo, "plus") + " −" + sum(wo, "minus") + " across " + (wo.files || []).length + " files, inside a coding slot."; },
    verify: function (wo) { var t = testsTotal(wo); return "Ran the required checks and " + t.total + " tests (" + t.failed + " failed), added " + (wo.tests ? wo.tests.added : 0) + " tests and mapped results to each acceptance criterion. Coverage on changed lines " + (wo.coverage ? wo.coverage.after + "%" : "n/a") + "."; },
    review: function (wo) { return "Reviewed the diff against the spec and plan: " + wo.reviewComments.length + " comments, all resolved before the human approval at G5. Merged with " + (wo.pr && wo.pr.mergeStrategy || "the repo's strategy") + "."; },
    close: function (wo) { return "Tagged " + (wo.pr && wo.pr.tag || "the release") + ", published release notes, closed the linked issue and watched health for 30 minutes."; }
  };
  function clsName(wo) { var c = G.find && G.find.cls ? G.find.cls(wo.cls) : null; return c ? c.name : wo.cls; }
  function sum(wo, k) { return (wo.files || []).reduce(function (t, f) { return t + f[k]; }, 0); }
  function testsTotal(wo) { var total = 0, failed = 0; (wo.criteria || []).forEach(function (c) { c.tests.forEach(function (t) { total++; if (t.result === "fail") failed++; }); }); return { total: total, failed: failed }; }

  function artefactsFor(wo, sid) {
    var t = topic(wo);
    if (sid === "research") return [{ kind: "note", title: "Research note: " + t, body: "Question: how does " + t + " behave today in " + wo.repo + "?\n\nFindings:\n1. The " + t + " logic lives in " + (wo.files && wo.files[0] ? wo.files[0].path.replace(/[^/]+$/, "") : "the main module") + ".\n2. Two callers depend on the current behaviour; neither needs a change.\n3. No incident in the last 30 days touched this path.\n\nUnknowns: none blocking." }];
    if (sid === "spec") return [{ kind: "spec", title: "Spec: " + wo.title, body: "Problem: " + wo.title + ".\n\nAcceptance criteria:\n" + (wo.criteria || []).map(function (c) { return c.id + " " + c.text; }).join("\n") + "\n\nOut of scope: " + ((wo.brief && wo.brief.scopeOut) || []).join("; ") + "." }];
    if (sid === "design") return [{ kind: "design", title: "Design notes: " + t, body: "Interface: " + t + "(request) returns result with an explicit error type.\nData: one new nullable field; no breaking change to existing payloads.\nRisk: clients that cache responses for more than 5 minutes may show the old value once." }];
    if (sid === "plan") return [{ kind: "plan", title: "Plan (" + (wo.plan || []).length + " steps)", body: (wo.plan || []).map(function (p) { return p.id + " " + p.text + " · " + p.files.join(", ") + " · serves " + p.ac.join(", "); }).join("\n") + "\nRollback: revert the PR" + ((wo.files || []).some(function (f) { return /sql$/.test(f.path); }) ? " and run the down migration." : ".") }];
    if (sid === "build") return [{ kind: "commits", title: wo.commits.length + " commits", body: wo.commits.map(function (c) { return c.hash + " " + c.message; }).join("\n") }];
    if (sid === "verify") return [{ kind: "tests", title: "Test report", body: (wo.criteria || []).map(function (c) { return c.id + " " + c.status + " (" + c.tests.length + " tests)"; }).join("\n") }];
    if (sid === "review") return [{ kind: "review", title: "Review summary", body: wo.reviewComments.map(function (c) { return (c.file ? c.file + ": " : "") + c.text + " → " + (c.resolution || "open"); }).join("\n") || "No comments." }];
    if (sid === "close") return [{ kind: "release", title: "Release notes " + (wo.pr && wo.pr.tag || ""), body: wo.pr && wo.pr.releaseNotes || "" }];
    return [];
  }

  function doBuild(wo, end) {
    var r = rngFor(wo.id + ":build");
    var t = topic(wo);
    if (!wo.commits.some(function (c) { return c.station === "build"; })) {
      var at = end - (wo.plan.length + 1) * 7 * MIN;
      wo.plan.forEach(function (p, i) {
        var files = p.files.slice();
        var verb = wo.cls === "bug" || wo.cls === "hotfix" ? "fix" : wo.cls === "docs" ? "docs" : wo.cls === "refactor" ? "refactor" : wo.cls === "chore" ? "chore" : wo.cls === "security" ? "fix(security)" : "feat";
        var msg = (i === 0 && wo.cls !== "docs" ? "test(" + t + "): " : verb + (verb.indexOf("(") < 0 ? "(" + t + ")" : "") + ": ") + p.text.charAt(0).toLowerCase() + p.text.slice(1);
        wo.commits.push({ hash: hex(r, 7), message: msg, agent: "ag-build", station: "build", at: at + i * 7 * MIN, files: files, step: p.id });
      });
    }
    wo.files.forEach(function (f) { f.state = "committed"; });
    var plus = sum(wo, "plus"), minus = sum(wo, "minus");
    wo.diff = { plus: plus, minus: minus, files: wo.files.length };
    var ag = G.find && G.find.agent ? G.find.agent("ag-build") : null;
    wo.guardrail = { maxDiff: ag ? ag.guardrails.maxDiff : 800, size: plus + minus, over: ag && ag.guardrails.maxDiff ? plus + minus > ag.guardrails.maxDiff : false, protectedTouched: wo.files.filter(function (f) { return f.protected; }).map(function (f) { return f.path; }) };
    if (!wo.pr) wo.pr = { number: 0, branch: "gantry/" + wo.id.toLowerCase(), checks: "pending", state: "open", tag: null };
    wo.pr.title = (wo.cls === "bug" || wo.cls === "hotfix" ? "Fix: " : "") + wo.title + " (" + wo.id + ")";
    wo.pr.body = "## What\n" + wo.title + ".\n\n## Why\n" + (wo.request ? wo.request.text : "") + "\n\n## Acceptance criteria\n" + (wo.criteria || []).map(function (c) { return "- [ ] " + c.id + " " + c.text; }).join("\n") + "\n\n## Plan\n" + wo.plan.map(function (p) { return "- " + p.id + " " + p.text; }).join("\n") + "\n\nGenerated by the Builder agent for Gantry work order " + wo.id + ".";
  }
  function doVerify(wo, end) {
    var r = rngFor(wo.id + ":verify");
    var failing = wo.state === "failed" && G.STATIONS[wo.station] && G.STATIONS[wo.station].id === "verify";
    (wo.criteria || []).forEach(function (c, i) {
      if (c.tests.length) return;
      var n = c.text.indexOf("documented") >= 0 || c.text.indexOf("Reviewed") >= 0 ? 0 : 1 + Math.floor(r() * 3);
      for (var k = 0; k < n; k++) c.tests.push({ name: (i === 1 ? "regression/" : "") + topic(wo) + "_" + ["happy_path", "edge_cases", "rounding", "idempotent_retry", "error_paths"][(i + k) % 5], result: failing && i === 0 && k === 0 ? "fail" : "pass", ms: Math.round(200 + r() * 4000) });
      c.status = !n ? (c.text.indexOf("documented") >= 0 ? "met" : "not tested") : c.tests.some(function (t) { return t.result === "fail"; }) ? "not met" : "met";
    });
    var repo = G.find && G.find.repo ? G.find.repo(wo.repo) : null;
    wo.checks = ((repo && repo.config.requiredChecks) || ["ci/test", "ci/lint"]).map(function (name, i) { return { name: name, status: failing && i === 0 ? "failed" : "passed", at: end }; });
    wo.security = { scanner: "security/scan", findings: wo.cls === "security" ? 0 : Math.floor(r() * 2), severity: "low", note: wo.cls === "security" ? "The reported vulnerability is no longer reproducible." : "No high or medium findings." };
    var before = 60 + Math.round(r() * 25);
    wo.coverage = { before: before, after: Math.min(98, before + Math.round(r() * 6)), changedLines: 80 + Math.round(r() * 18) };
    var t = testsTotal(wo);
    wo.tests = { passed: t.total - t.failed + Math.round(80 + r() * 300), failed: t.failed, added: (wo.files || []).filter(function (f) { return /test|tftest/.test(f.path) && f.status === "added"; }).length + 1 };
    if (!wo.commits.some(function (c) { return c.station === "verify"; }) && wo.files.some(function (f) { return /test/.test(f.path); })) {
      var tf = wo.files.find(function (f) { return /test/.test(f.path); });
      tf.plus += 12;
      wo.commits.push({ hash: hex(r, 7), message: "test(" + topic(wo) + "): cover the edge cases found while verifying", agent: "ag-test", station: "verify", at: end - 4 * MIN, files: [tf.path], step: tf.step });
      wo.diff = { plus: sum(wo, "plus"), minus: sum(wo, "minus"), files: wo.files.length };
    }
  }
  function doReview(wo, end) {
    var r = rngFor(wo.id + ":review");
    if (!wo.reviewComments.length) {
      var code = (wo.files || []).filter(function (f) { return !/test|md$/.test(f.path) && f.status !== "deleted"; });
      var n = Math.min(code.length, 1 + Math.floor(r() * 3));
      var texts = ["Return a typed error instead of a string here.", "This branch is not covered by a test.", "Name the constant; the magic number hides the rounding rule.", "Log the work order id, not the full payload."];
      var fixes = ["Changed to a typed error in a follow-up commit.", "Added a test for the branch.", "Extracted ROUND_MODE constant.", "Now logs the id only."];
      for (var i = 0; i < n; i++) {
        wo.reviewComments.push({ by: i === 0 ? "ag-review" : (wo.gates.G5 && wo.gates.G5.approvals[0] ? wo.gates.G5.approvals[0].by : "ag-review"), at: end - (20 - i * 3) * MIN, file: code[i].path, line: 10 + Math.floor(r() * 80), text: texts[i % texts.length], resolved: true, resolution: fixes[i % fixes.length] });
      }
      if (n) {
        wo.commits.push({ hash: hex(r, 7), message: "fix(" + topic(wo) + "): address review comments", agent: "ag-build", station: "review", at: end - 8 * MIN, files: code.slice(0, n).map(function (f) { return f.path; }), step: code[0].step });
        code.slice(0, n).forEach(function (f) { f.plus += 4; f.minus += 2; });
        wo.diff = { plus: sum(wo, "plus"), minus: sum(wo, "minus"), files: wo.files.length };
      }
    }
    if (wo.pr) {
      wo.pr.reviewers = ["ag-review"].concat(wo.gates.G5 ? wo.gates.G5.approvals.map(function (a) { return a.by; }) : []);
      var repo = G.find && G.find.repo ? G.find.repo(wo.repo) : null;
      wo.pr.mergeStrategy = repo ? repo.config.merge : "squash";
      if (wo.gates.G5 && wo.gates.G5.status === "passed") { wo.pr.state = "merged"; wo.pr.mergedAt = wo.gates.G5.approvals.length ? wo.gates.G5.approvals[wo.gates.G5.approvals.length - 1].at : end; wo.pr.mergedBy = "ag-review"; wo.pr.checks = "green"; }
      wo.files.forEach(function (f) { f.state = "merged"; });
    }
  }
  function doClose(wo, end) {
    var r = rngFor(wo.id + ":close");
    if (!wo.pr) return;
    if (!wo.pr.tag) wo.pr.tag = "v1." + (2 + (hash(wo.repo) % 18)) + "." + (hash(wo.id) % 9);
    wo.pr.releaseNotes = "## " + wo.pr.tag + "\n\n### " + (wo.cls === "bug" || wo.cls === "hotfix" || wo.cls === "security" ? "Fixed" : wo.cls === "docs" ? "Docs" : "Added") + "\n- " + wo.title + " (" + wo.id + ", PR #" + wo.pr.number + ")\n";
    wo.pr.releasedAt = wo.pr.releasedAt || end;
  }
  function doOutcome(wo) {
    if (wo.outcomes.length || wo.state !== "done" || wo.split) return;
    var r = rngFor(wo.id + ":outcome");
    var x = r();
    var at = (wo.doneAt || Date.now()) + 2 * 60 * MIN;
    if (wo.outcomeOverride) { wo.outcomes.push(wo.outcomeOverride); delete wo.outcomeOverride; return; }
    if (x < 0.06) wo.outcomes.push({ kind: "revert", at: at, text: "Reverted after a spike in 5xx on " + wo.repo + "; reapplied with a fix the next day.", severity: "medium" });
    else if (x < 0.1) wo.outcomes.push({ kind: "incident", at: at, text: "Minor incident: one tenant saw stale values for 12 minutes.", severity: "low" });
    else wo.outcomes.push({ kind: "healthy", at: at, text: "No errors, reverts or incidents in the 30-minute watch after release." });
  }

  /* fill station summaries and artefacts for every finished visit; materialise build/verify/review/close data */
  function sync(wo) {
    ensure(wo);
    if (!wo.criteria) { (wo.history || []).forEach(function (e) { if (e.station === "intake" && e.endedAt && !e.summary) e.summary = SUMMARY.intake(wo); }); return wo; }
    var agents = G.find && G.find.agent;
    (wo.history || []).forEach(function (e) {
      var ag = agents ? G.find.agent(e.agent) : null;
      if (!e.agentVersion && ag) e.agentVersion = ag.version;
      if (!e.skills && ag) e.skills = ag.skills.map(function (id) { var s = G.find.skill(id); return { id: id, name: s ? s.name : id, v: s ? s.version : "?" }; });
      if (!e.endedAt) return;
      if (e.outcome === "killed" || e.outcome === "sent back" || /^rejected/.test(e.outcome || "")) { if (!e.summary) e.summary = "Stopped: " + (e.outcome || "") + (e.note ? " (" + e.note + ")" : "") + "."; return; }
      if (e.station === "build") doBuild(wo, e.endedAt);
      if (e.station === "verify") doVerify(wo, e.endedAt);
      if (e.station === "review") doReview(wo, e.endedAt);
      if (e.station === "close" && wo.gates.G6 && wo.gates.G6.status === "passed") doClose(wo, e.endedAt);
      if (!e.summary) e.summary = (SUMMARY[e.station] || function () { var d = G.stationDef && G.stationDef(e.station); return (d ? d.name : e.station) + ": " + (d && d.purpose ? d.purpose : "station finished") + "."; })(wo);
      if (!e.artefacts) e.artefacts = artefactsFor(wo, e.station);
    });
    if (wo.state === "done" && wo.pr) { doClose(wo, wo.doneAt || Date.now()); }
    doOutcome(wo);
    return wo;
  }

  /* completeness of the record sections (for the meter on #record) */
  function completeness(wo) {
    sync(wo);
    var s = {
      summary: true, request: !!wo.request, clarification: !!(wo.conv && wo.conv.messages.length), agreement: wo.briefVersions.length > 0,
      stations: wo.history.some(function (e) { return e.summary; }), changes: wo.commits.length > 0, verification: (wo.criteria || []).some(function (c) { return c.tests.length; }),
      merge: !!(wo.pr && wo.pr.state === "merged"), approvals: Object.keys(wo.gates).some(function (k) { return wo.gates[k].approvals.length || wo.gates[k].decision; }), after: wo.outcomes.length > 0, timeline: true
    };
    var keys = Object.keys(s);
    return { sections: s, done: keys.filter(function (k) { return s[k]; }).length, total: keys.length };
  }

  /* plain-language summary paragraph (local; G.ask can rewrite it) */
  function summaryText(wo) {
    sync(wo);
    var p = G.find ? G.find.project(wo.project) : null;
    var st = G.STATIONS[wo.station];
    var asked = G.actorName ? G.actorName(wo.requestedBy) : wo.requestedBy;
    var state = wo.state === "done" ? "It shipped" + (wo.pr && wo.pr.tag ? " as " + wo.pr.tag : "") + (wo.doneAt && G.fmt ? " on " + G.fmt.stamp(wo.doneAt) : "") + "." : wo.state === "killed" ? "It was killed: " + (wo.killed ? wo.killed.reason : "") + "." : wo.bay ? "It is in " + (G.bayDef(wo.bay) || { name: wo.bay }).name + (wo.bayReason ? " (" + wo.bayReason + ")" : "") + "." : "It is " + (wo.state === "waiting" ? "waiting at a gate after " : wo.state + " at ") + (st ? st.name : "a station") + ".";
    var delivered = wo.commits.length ? " The change touches " + wo.files.length + " files (+" + sum(wo, "plus") + " −" + sum(wo, "minus") + ") in " + wo.commits.length + " commits" + (wo.pr && wo.pr.number ? ", PR #" + wo.pr.number : "") + "." : "";
    var met = (wo.criteria || []).filter(function (c) { return c.status === "met"; }).length;
    return asked + " asked for \"" + wo.title + "\" in " + (p ? p.name : wo.project) + " (" + wo.repo + ") via " + (G.sourceLabel ? G.sourceLabel(wo.sourceIntegration || wo.source) : wo.source) + ". Gantry classified it as " + clsName(wo) + "." + delivered + (wo.criteria ? " " + met + " of " + wo.criteria.length + " acceptance criteria are met." : "") + " " + state;
  }

  G.lc = { ensure: ensure, sync: sync, completeness: completeness, summaryText: summaryText, topic: topic, criteriaFor: criteriaFor };
})(window.G);
