// Tests for the 2026-11-23 Pi review items handled in the extension and workflow files:
//  13. kb-query (a single-agent root, not a sequence) can be resumed
//  14. attorney-gate's prompt allows the JSON result legal-research asks for
//  16. deposition-prep's answer-prep step runs on prep_model (default: the Local model box)
// The app-side parts (12, 13, 15, 16) are in Tests/PiTests/WorkflowsAndModelsTests.swift.
// Run: npm test (from .pi/extensions/orchestrator).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { RunStore } from "../store.ts";
import { Journal, buildResumeFlow, type AgentsApi } from "../journal.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const readRepo = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

/** How a saved single-agent workflow such as kb-query is stored once pi-agents expands it. */
const KB_FLOW = {
  kind: "workflow",
  name: "kb-query",
  params: { run_id: "", question: "", knowledge_dir: "knowledge" },
  body: { kind: "agent", profile: "kb-answerer", task: "Question: {params.question}\nKnowledge folder: {params.knowledge_dir}" },
};

test("13: a single-node root resumes as a one-step sequence that runs that node again, params filled in", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kb-resume-"));
  const db = new RunStore(dir);
  try {
    db.createRun({ id: "kb-1", workflow: "kb-query", title: "KB", params: { run_id: "kb-1", question: "What is {residuals}?", knowledge_dir: "knowledge" } });
    db.setFlow("kb-1", KB_FLOW, undefined);
    db.markFinished("kb-1", { status: "failed", error: "model dropped the result" });
    const built = buildResumeFlow(db.getRun("kb-1")!, db.completedStepValues("kb-1"), db.stepOverrides("kb-1"));
    assert.equal(built.resumeAt, 0);
    assert.equal(built.rebinds, 0);
    assert.equal(built.resumeOffset, 0);
    assert.equal(built.flow.kind, "sequence");
    assert.equal(built.flow.steps.length, 1);
    const step = built.flow.steps[0] as { kind: string; profile: string; task: string };
    assert.equal(step.kind, "agent");
    assert.equal(step.profile, "kb-answerer");
    // Inline flows carry no params; braces in a param value stay literal.
    assert.equal(step.task, "Question: What is {{residuals}}?\nKnowledge folder: knowledge");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("13: resuming a stopped kb-query run starts it instead of erroring", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kb-resume-journal-"));
  const db = new RunStore(dir);
  const starts: Array<Parameters<AgentsApi["start"]>[0]> = [];
  const agents: AgentsApi = { async start(params) { starts.push(params); return { runId: "pi-resumed" }; } } as AgentsApi;
  const journal = new Journal(() => db, agents, { pid: 4242, pidAlive: () => false, ownerExitWaitMs: 0 });
  try {
    db.createRun({ id: "kb-2", workflow: "kb-query", title: "KB", params: { run_id: "kb-2", question: "q", knowledge_dir: "k" }, ownerPid: 5151 });
    db.markStarted("kb-2", "pi-original", 5151);
    db.setFlow("kb-2", KB_FLOW, undefined);
    db.markFinished("kb-2", { status: "stopped" });
    const reply = await journal.resume(db, { runId: "kb-2" });
    assert.equal(reply.ok, true, String(reply.error));
    assert.equal(starts.length, 1);
    assert.deepEqual((starts[0].flow as { kind: string; steps: unknown[] }).kind, "sequence");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("13: a run with no usable flow still says why it cannot resume", () => {
  const row = { flow_json: JSON.stringify({ kind: "workflow", name: "x" }), params_json: "{}" } as any;
  assert.throws(() => buildResumeFlow(row, new Map(), new Map()), /no resumable flow/);
});

/** Every attorney-gate step in every workflow, with the file it is in. */
function attorneyGateSteps(): Array<{ file: string; step: Record<string, any> }> {
  const out: Array<{ file: string; step: Record<string, any> }> = [];
  const walk = (node: unknown, file: string) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, file));
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, any>;
    if (obj.profile === "attorney-gate") out.push({ file, step: obj });
    Object.values(obj).forEach((v) => walk(v, file));
  };
  for (const f of fs.readdirSync(path.join(REPO, ".pi/workflows")).filter((f) => f.endsWith(".yaml"))) {
    walk(YAML.parse(readRepo(`.pi/workflows/${f}`)), f);
  }
  return out;
}

test("14: attorney-gate allows the JSON {decision, comment} result a step's schema asks for", () => {
  const persona = readRepo(".pi/agents/attorney-gate.md");
  const jsonSteps = attorneyGateSteps().filter(({ step }) => step.json);
  assert.ok(jsonSteps.some(({ file }) => file === "legal-research.yaml"), "legal-research's gate has a JSON schema");
  for (const { file, step } of jsonSteps) {
    assert.deepEqual([...step.json.required].sort(), ["comment", "decision"], file);
  }
  // The persona no longer says "always Markdown verbatim" with no exception.
  assert.match(persona, /When your task asks for a JSON object/);
  assert.match(persona, /`decision`/);
  assert.match(persona, /`comment`/);
  assert.match(persona, /copied exactly/);
  // The verbatim default stays for every Markdown gate.
  assert.match(persona, /By default\*\* the result is the tool's returned text/);
});

test("16: deposition-prep runs answer-prep on prep_model (default Local model box), and only the qwen3-coder-next copy pins a model", () => {
  const wf = YAML.parse(readRepo(".pi/workflows/deposition-prep.yaml"));
  const param = wf.params.find((p: { name: string }) => p.name === "prep_model");
  const passed = "ollama/qwen3-coder-next:q4_K_M";
  assert.equal(param.default, "Local model box");
  assert.notEqual(param.required, true);
  // README records that qwen3-coder-next passed the witness-coaching guard, that the Local model box
  // has not been probed, and that the guard still checks every answer-prep result.
  const readme = readRepo("README.md");
  assert.match(readme, /qwen3-coder-next[\s\S]{0,80}passed the guard/);
  assert.match(readme, /has not been put through the witness-preparation probe yet/);
  assert.match(readme, /guard still checks every answer-prep\s+result/);
  // The launch card offers the default first and keeps qwen3-coder-next as a non-default choice.
  const launch = YAML.parse(wf.doc.split("```orchestrator-launch")[1].split("```")[0]);
  const field = launch.fields.find((f: { param: string }) => f.param === "prep_model");
  assert.deepEqual(field.options, ["Local model box", passed]);

  const pinned: Array<{ label: string; model: string }> = [];
  const prepSteps: Array<Record<string, any>> = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, any>;
    if (obj.model) pinned.push({ label: obj.label, model: obj.model });
    if (obj.profile === "depo-answer-prep") prepSteps.push(obj);
    Object.values(obj).forEach(walk);
  };
  walk(wf.flow);
  assert.deepEqual(pinned, [{ label: "answer-prep", model: passed }]);
  assert.equal(prepSteps.length, 2, "the pinned step and the Local-model-box step");
  assert.equal(prepSteps[0].task, prepSteps[1].task, "both copies run the same task");

  // The switch chooses the pinned copy only for qwen3-coder-next; the default falls to the unpinned
  // copy (the app's Local model box), and `prep` is bound either way.
  const crossExam = wf.flow.steps[1].cases[0].then.steps;
  const sw = crossExam.find((s: { label?: string }) => s.label === "prep-model");
  assert.equal(sw.kind, "switch");
  assert.equal(sw.on, "{params.prep_model}");
  assert.equal(sw.cases.length, 1);
  assert.deepEqual(sw.cases[0].when, { eq: ["", passed] });
  assert.notDeepEqual(sw.cases[0].when, { eq: ["", param.default] });
  assert.equal(sw.cases[0].then.model, passed);
  assert.equal(sw.else.model, undefined);
  assert.equal(sw.as, "prep");
});

test("deal-memo stays bounded and skips the app-only partner gate for terminal runs", () => {
  const wf = YAML.parse(readRepo(".pi/workflows/deal-memo.yaml"));
  const review = wf.flow.steps.find((s: { label?: string }) => s.label === "partner-review");
  assert.equal(review.kind, "switch");
  assert.equal(review.on, "{params.run_id}");
  assert.deepEqual(review.cases[0].when, { eq: ["", ""] });
  assert.match(review.cases[0].then.value, /DECISION: skipped/);
  assert.equal(review.else.profile, "attorney-gate");
  assert.equal(review.as, "gate");

  const drafter = readRepo(".pi/agents/deal-memo-drafter.md");
  const synthesizer = readRepo(".pi/agents/deal-memo-synthesizer.md");
  assert.match(drafter, /under 500 words/);
  assert.match(drafter, /Do not invent dates, dollar amounts, percentages/);
  assert.match(synthesizer, /under 2,500 words/);
  assert.match(synthesizer, /Do not add dates, deal economics, legal requirements/);
});

test("adversarial-brief keeps debate analysis source-bound and terminal runs deterministic", () => {
  const wf = YAML.parse(readRepo(".pi/workflows/adversarial-brief.yaml"));
  const threshold = wf.params.find((p: { name: string }) => p.name === "severity_threshold");
  const launch = YAML.parse(wf.doc.split("```orchestrator-launch")[1].split("```")[0]);
  const thresholdField = launch.fields.find((f: { param: string }) => f.param === "severity_threshold");
  assert.equal(threshold.default, "10");
  assert.deepEqual(thresholdField.options, ["5", "6", "7", "8", "9", "10"]);
  const debateTeams: Array<Record<string, any>> = [];
  const collectTeams = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(collectTeams);
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, any>;
    if (obj.kind === "parallel" && ["blue-team", "red-team"].includes(obj.label)) debateTeams.push(obj);
    Object.values(obj).forEach(collectTeams);
  };
  collectTeams(wf.flow);
  assert.equal(debateTeams.length, 4);
  for (const team of debateTeams) assert.equal(team.concurrency, 1, team.label);
  for (const label of ["attorney-gate", "quality-guards"]) {
    const step = wf.flow.steps.find((s: { label?: string }) => s.label === label);
    assert.equal(step.kind, "switch", label);
    assert.equal(step.on, "{params.run_id}", label);
    assert.deepEqual(step.cases[0].when, { eq: ["", ""] }, label);
    assert.equal(step.as, label === "attorney-gate" ? "gate" : "guards", label);
  }
  const synthesizer = readRepo(".pi/agents/brief-synthesizer.md");
  const writer = readRepo(".pi/agents/brief-report-writer.md");
  const analyst = readRepo(".pi/agents/brief-analyst.md");
  const fortifier = readRepo(".pi/agents/brief-fortifier.md");
  assert.match(synthesizer, /Stay under 1,800 words/);
  assert.match(synthesizer, /Prefix conclusions drawn from the debate with `Debate assessment:`/);
  assert.match(writer, /Stay under 3,500 words/);
  assert.match(writer, /Do not state that a party conceded, filed, invoked a protocol/);
  assert.match(writer, /Every review-checklist line must begin exactly/);
  assert.match(analyst, /## Original brief/);
  assert.match(analyst, /complete source brief verbatim/);
  assert.match(fortifier, /tools: \[\]/);
  assert.match(fortifier, /complete original brief is supplied in the task/);
  assert.match(fortifier, /decision is `skipped`, apply no recommendations/);
  const fortifierStep = wf.flow.steps.find((s: { label?: string }) => s.label === "fortifier");
  assert.match(fortifierStep.task, /DECISION is skipped, apply no recommendations/);
});
