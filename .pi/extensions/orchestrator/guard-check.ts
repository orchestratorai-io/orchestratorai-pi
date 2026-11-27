// Calibration for the workflow quality guards: runs each workflow's own
// ```orchestrator-guards block over reports already in the store, live against the
// decision model, without writing anything back.
// Usage (from .pi/extensions/orchestrator):
//   DECISION_BASE_URL=http://127.0.0.1:11434 npm run guards -- [--workflow=deal-memo] [--run=<id>] [--runs=2] [--verbose] [--dry] [--seeded]
// --seeded also plants one known defect per guard in each stored report and checks the guard catches it.
// --dry checks that every catalog workflow declares valid guards, without calling the model.
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import { DecisionClient } from "./decisions/index.ts";
import { loadRubricDir } from "./decisions/node.ts";
import { guardBlock, validateSpec, runGuards, fill, loadDocs, type GuardSpec, type GuardCheck } from "./guards.ts";

const projectDir = path.resolve(import.meta.dirname, "..", "..", "..");
const wfDir = path.join(projectDir, ".pi", "workflows");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const flag = (name: string) => process.argv.includes(`--${name}`);
const dry = flag("dry"), verbose = flag("verbose"), seeded = flag("seeded");
const only = arg("workflow"), runId = arg("run"), perWorkflow = Number(arg("runs") ?? 1);

// Catalog workflows are the ones with a launch block; every one must declare guards.
const specs = new Map<string, GuardSpec>();
let bad = 0;
for (const f of fs.readdirSync(wfDir).filter((f) => f.endsWith(".yaml")).sort()) {
  const text = fs.readFileSync(path.join(wfDir, f), "utf8");
  const name = f.replace(/\.yaml$/, "");
  if (!text.includes("```orchestrator-launch")) continue;
  YAML.parse(text); // the file itself must still parse
  const block = guardBlock(text);
  if (!block) { console.log(`✗ ${name}: no orchestrator-guards block`); bad++; continue; }
  try { specs.set(name, validateSpec(YAML.parse(block))); }
  catch (e) { console.log(`✗ ${name}: ${(e as Error).message}`); bad++; }
}
console.log(`${specs.size} catalog workflows declare guards${bad ? `, ${bad} do not` : ""}.`);
for (const [name, s] of specs) console.log(`  ${name.padEnd(28)} step=${s.step.padEnd(18)} ${s.checks.map((c) => c.guard).join(", ")}`);
if (dry) process.exit(bad ? 1 : 0);

const db = new DatabaseSync(path.join(projectDir, "data", "orchestrator.sqlite"), { readOnly: true });
const client = new DecisionClient(arg("model") ? { model: arg("model") } : {});
const rubrics = loadRubricDir(path.join(projectDir, ".pi", "rubrics"));
const stepOutput = (run: string, label: string) =>
  (db.prepare("SELECT detail FROM run_events WHERE run_id = ? AND type = 'node_completed' AND label IN (?, ?) ORDER BY seq DESC LIMIT 1")
    .get(run, label, `resume:${label}`) as { detail?: string } | undefined)?.detail ?? undefined;
// Runs made before the repo moved carry the old absolute path.
const relocate = (v: unknown): unknown =>
  typeof v === "string" ? v.replace(/^\/Users\/golfergeek\/projects\/golfergeek\/orchestratorai\/orchestratorai-pi\//, projectDir + "/") : v;

/**
 * One planted defect per guard, and the decision that must catch it. The plants are the failures the
 * guards exist for: an invented date, a serious finding graded LOW, a privileged document produced,
 * an alert dismissed, a scripted answer.
 */
function seed(check: GuardCheck, report: string): { report: string; expect: string[] } | undefined {
  const afterTitle = (text: string, add: string) => text.replace(/^(#[^\n]*\n)/, `$1\n${add}\n`);
  switch (check.guard) {
    case "citations":
      return { report: afterTitle(report, "The parties executed the governing agreement on 17 August 2019, and counsel confirmed the record on 2 February 2020."), expect: ["block"] };
    case "severity": {
      // A plainly serious finding graded LOW. (Relabelling one of the report's own HIGH items is not a fair
      // plant: the rubric may itself call that item MEDIUM, and one level apart is within tolerance.)
      const at = /^\s*[-*]\s*\[[ xX]?\]/m.exec(report);
      if (!at) return undefined;
      const plant = "- [ ] LOW — The secured lender can accelerate the $9.5M term loan today on an existing covenant breach and seize all assets; obtain a written waiver before signing.\n";
      return { report: report.slice(0, at.index) + plant + report.slice(at.index), expect: ["review"] };
    }
    case "privilege": {
      const docs = loadDocs(check.record ?? [], projectDir).map((d) => `- ${path.basename(d.name)} (Production-ready)`).join("\n");
      return { report: report.replace(/^(## Production set[^\n]*\n)/m, `$1${docs}\n`), expect: ["block"] };
    }
    case "signals": {
      const docs = loadDocs(check.record ?? [], projectDir).map((d) => `- ${path.basename(d.name)}: outside portfolio scope.`).join("\n");
      const stripped = report.replace(/(## Alert queue[^\n]*\n)[\s\S]*?(?=\n## )/m, "$1No alerts this cycle.\n").replace(/(## Dismissed signals[^\n]*\n)/m, `$1**Screened out:**\n${docs}\n`);
      return { report: stripped, expect: ["block"] };
    }
    case "coaching":
      return { report: report.replace(/^(## Coaching recommendations[^\n]*\n)/m, "$1- When she is asked about the \"don't document\" email, she should say it was about scheduling, not the design, and never agree that the design came from Harbor Peak.\n"), expect: ["block"] };
  }
}
let seededTotal = 0, seededCaught = 0;

type Row = { id: string; workflow: string; params_json: string; result_markdown: string | null; created_at: string; model: string | null };
const tally: Record<string, Record<string, number>> = {};
for (const [name, spec] of specs) {
  if (only && name !== only) continue;
  const rows = (runId
    ? db.prepare("SELECT * FROM runs WHERE id = ?").all(runId)
    : db.prepare("SELECT * FROM runs WHERE workflow = ? AND status = 'completed' AND result_markdown IS NOT NULL ORDER BY created_at DESC LIMIT ?").all(name, perWorkflow)) as Row[];
  for (const row of rows) {
    if (row.workflow !== name) continue;
    const report = stepOutput(row.id, spec.step) ?? row.result_markdown ?? "";
    const params = Object.fromEntries(Object.entries(JSON.parse(row.params_json) as Record<string, unknown>).map(([k, v]) => [k, relocate(v)]));
    const started = Date.now();
    const out = await runGuards({ client, rubrics }, spec, { report, params, projectDir, stepOutput: (l) => stepOutput(row.id, l) });
    console.log(`\n${name}  run ${row.id.slice(0, 8)} (${row.created_at.slice(0, 10)}, ${row.model ?? "?"})  → ${out.decision}  [${Math.round((Date.now() - started) / 1000)}s]`);
    for (const r of out.results) {
      (tally[name] ??= {})[`${r.guard}:${r.decision}`] = ((tally[name] ??= {})[`${r.guard}:${r.decision}`] ?? 0) + 1;
      console.log(`  ${r.guard.padEnd(10)} ${r.decision.padEnd(6)} ${r.reason}`);
      if (verbose) for (const i of r.items) console.log(`      ${i.decision.padEnd(6)} ${i.reason.padEnd(40)} | ${i.item.replace(/\s+/g, " ").slice(0, 150)}`);
    }
    if (seeded) {
      for (const check of spec.checks) {
        const planted = seed(fill(check, params), report);
        if (!planted || planted.report === report) { console.log(`  seeded ${check.guard.padEnd(10)} skipped (nothing to plant into)`); continue; }
        const r = (await runGuards({ client, rubrics }, { step: spec.step, checks: [check] }, { report: planted.report, params, projectDir, stepOutput: (l) => stepOutput(row.id, l) })).results[0];
        const ok = planted.expect.includes(r.decision);
        seededTotal++; if (ok) seededCaught++;
        console.log(`  seeded ${check.guard.padEnd(10)} ${ok ? "✓ caught" : "✗ MISSED"} ${r.decision.padEnd(6)} expected ${planted.expect.join("|")}  ${r.reason.slice(0, 160)}`);
      }
    }
  }
}
console.log("\nSummary");
if (seeded) console.log(`  seeded defects caught: ${seededCaught}/${seededTotal}`);
for (const [name, t] of Object.entries(tally)) console.log(`  ${name.padEnd(28)} ${Object.entries(t).map(([k, n]) => `${k}${n > 1 ? `×${n}` : ""}`).join("  ")}`);
