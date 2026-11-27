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
import { ollamaThinkingPayload } from "../ollama-thinking.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const readRepo = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

test("Ollama Qwen requests explicitly honor Pi's disabled thinking", () => {
  const payload = { messages: [], stream: true };
  const qwen = { provider: "ollama", api: "openai-completions", id: "qwen3.6:35b-mlx" };
  assert.deepEqual(ollamaThinkingPayload(payload, qwen, "off"), { ...payload, reasoning_effort: "none" });
  assert.deepEqual(ollamaThinkingPayload(payload, { ...qwen, id: "qwen3.5:9b" }, "off"),
    { ...payload, reasoning_effort: "none" });
  assert.equal(ollamaThinkingPayload(payload, qwen, "low"), undefined);
  assert.equal(ollamaThinkingPayload(payload, { ...qwen, provider: "other" }, "off"), undefined);
  assert.equal(ollamaThinkingPayload(payload, { ...qwen, api: "other" }, "off"), undefined);
  assert.equal(ollamaThinkingPayload(payload, { ...qwen, id: "gemma4:e4b" }, "off"), undefined);
});

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

test("cross-exam simulation keeps terminal turns deterministic and coaching non-scripted", () => {
  const wf = YAML.parse(readRepo(".pi/workflows/cross-exam-simulation.yaml"));
  assert.match(wf.params.find((p: { name: string }) => p.name === "case_facts").default, /Harbor Peak alleges/);
  const loop = wf.flow.steps.find((s: { label?: string }) => s.label === "examination");
  assert.equal(loop.kind, "while");
  assert.equal(loop.max, 5);
  const scorer = loop.body.steps.find((s: { label?: string }) => s.label === "scorer");
  assert.equal(scorer.json.properties.transcript, undefined, "the model only scores the current turn");
  const accumulated = loop.body.steps.at(-1);
  assert.equal(accumulated.kind, "value");
  assert.match(accumulated.value.transcript, /\{current\.transcript\}[\s\S]*\{q\.question\}[\s\S]*\{answer\}/);
  const answer = loop.body.steps.find((s: { label?: string }) => s.label === "witness-answer");
  assert.equal(answer.kind, "switch");
  assert.equal(answer.on, "{params.run_id}");
  assert.match(answer.cases[0].then.value, /need to review the underlying records/);
  const guard = wf.flow.steps.find((s: { label?: string }) => s.label === "quality-guards");
  assert.equal(guard.kind, "switch");
  const assembly = wf.flow.steps.find((s: { label?: string }) => s.label === "debrief");
  assert.equal(assembly.kind, "value");
  assert.match(assembly.value, /## Transcript\n\{exam\.transcript\}/);
  const debrief = wf.flow.steps.find((s: { label?: string }) => s.label === "debrief-analysis");
  assert.doesNotMatch(debrief.task, /\{strategy\}/);
  assert.match(debrief.task, /Every checklist line MUST begin exactly/);
  assert.match(debrief.task, /must not script testimony/);
  assert.equal(debrief.json.properties.coaching.minItems, 3);
  assert.equal(debrief.json.properties.coaching.maxItems, 3);
  assert.match(assembly.value, /## Coaching recommendations\n- Turn \{analysis\.coaching\.0\.turn\}/);
  assert.match(debrief.task, /Prefix every inference with `Assessment:`/);
  assert.match(debrief.task, /Analyze only the transcript and scores/);
  assert.match(debrief.task, /tactic for counsel/);
  assert.match(debrief.task, /same fixed terminal response/);
  for (const name of ["xexam-strategist", "xexam-question-generator", "xexam-answer-scorer", "xexam-debriefer"]) {
    const profile = readRepo(`.pi/agents/${name}.md`);
    assert.match(profile, /thinking: off/);
  }
  assert.match(readRepo(".pi/agents/xexam-debriefer.md"), /Never script testimony/);
});

test("discovery review withholds uncertain privilege and skips app gates in terminal runs", () => {
  const wf = YAML.parse(readRepo(".pi/workflows/discovery-review.yaml"));
  for (const label of ["gate-1-privilege", "gate-2-relevance", "gate-3-hot-docs", "gate-4-qa-sample", "quality-guards"]) {
    const step = wf.flow.steps.find((s: { label?: string }) => s.label === label);
    assert.equal(step.kind, "switch", label);
    assert.equal(step.on, "{params.run_id}", label);
  }
  const inventory = wf.flow.steps.find((s: { label?: string }) => s.label === "inventory");
  assert.match(inventory.task, /Exclude README files/);
  const report = wf.flow.steps.find((s: { label?: string }) => s.label === "report");
  assert.match(report.task, /A skipped gate clears nothing/);
  assert.match(report.task, /Every checklist line MUST begin exactly/);
  const writer = readRepo(".pi/agents/discovery-production-writer.md");
  assert.match(writer, /potentially-privileged/);
  assert.match(writer, /A skipped gate never clears a document/);
});

test("due diligence stays source-bound and skips app gates in terminal runs", () => {
  const wf = YAML.parse(readRepo(".pi/workflows/due-diligence.yaml"));
  for (const label of ["gate-1-analysis", "gate-2-synthesis", "quality-guards"]) {
    const step = wf.flow.steps.find((s: { label?: string }) => s.label === label);
    assert.equal(step.kind, "switch", label);
    assert.equal(step.on, "{params.run_id}", label);
  }
  const synthesis = wf.flow.steps.find((s: { label?: string }) => s.label === "synthesis");
  const analyse = wf.flow.steps.find((s: { label?: string }) => s.label === "analyse");
  assert.equal(analyse.concurrency, 1);
  assert.match(analyse.body.task, /CLOSED RECORD: aim for 350 words/);
  assert.match(analyse.body.task, /Never mention invalidity, CJEU, Schrems, 2020/);
  assert.match(synthesis.task, /under 1,500 words/);
  assert.match(synthesis.task, /prefix\s+every inference with `Assessment:`/);
  const report = wf.flow.steps.find((s: { label?: string }) => s.label === "report");
  assert.match(report.task, /A skipped gate records no correction/);
  assert.match(report.task, /Every checklist line MUST begin exactly/);
  assert.match(readRepo(".pi/agents/dd-synthesizer.md"), /Do not invent or extrapolate dates, amounts/);
  assert.match(readRepo(".pi/agents/dd-report-writer.md"), /never turn a possible remedy or future event into a certainty/);
  assert.match(readRepo(".pi/agents/dd-report-writer.md"), /Do not add outside law, regulatory dates, fine caps/);
  assert.match(readRepo(".pi/agents/dd-report-writer.md"), /delete any matrix language about invalidity, CJEU, Schrems, 2020/);
  assert.match(readRepo(".pi/agents/dd-report-writer.md"), /Every inferred diligence request must begin `Recommendation:`/);
  assert.match(readRepo(".pi/agents/dd-report-writer.md"), /never list gate status, skipped decisions/);
  assert.match(readRepo(".pi/agents/dd-report-writer.md"), /sub-processors HIGH or MEDIUM, never LOW/);
});

test("trial simulator bounds scenario context and labels simulated conclusions", () => {
  const wf = YAML.parse(readRepo(".pi/workflows/monte-carlo-trial-simulator.yaml"));
  const simulate = wf.flow.steps.find((s: { label?: string }) => s.label === "simulate");
  assert.equal(simulate.concurrency, 1);
  const argument = simulate.body.steps.find((s: { label?: string }) => s.label === "argument");
  for (const branch of Object.values(argument.branches) as Array<{ task: string }>) {
    assert.match(branch.task, /Stay under 600 words/);
    assert.match(branch.task, /Prefix jury inferences with `Argument:`/);
  }
  const statistics = wf.flow.steps.find((s: { label?: string }) => s.label === "statistics");
  assert.match(statistics.task, /fewer\s+than 10 outcomes report min\/max rather than interpolated percentiles/);
  assert.match(statistics.task, /Label every sensitivity\s+conclusion `Simulation association:`/);
  const report = wf.flow.steps.find((s: { label?: string }) => s.label === "report");
  assert.match(report.task, /CLOSED RECORD: stay under 2,000 words/);
  assert.match(report.task, /Never say a simulated judge or jury actually\s+ruled/);
  assert.match(report.task, /Never turn scenario frequency into probability/);
  assert.match(report.task, /simulation log may contain only SIM id, verdict, damages/);
  assert.match(report.task, /never say an exception was established/);
  assert.match(report.task, /Every checklist line MUST begin exactly/);
  const guard = wf.flow.steps.find((s: { label?: string }) => s.label === "quality-guards");
  assert.equal(guard.kind, "switch");
  assert.equal(guard.on, "{params.run_id}");
  for (const name of ["trial-parameter-designer", "trial-advocate", "trial-jury", "trial-statistician", "trial-report-writer"]) {
    assert.match(readRepo(`.pi/agents/${name}.md`), /thinking: off/);
  }
  assert.match(readRepo(".pi/agents/trial-jury.md"), /A plaintiff or mixed verdict must copy one exact nonzero dollar figure/);
  assert.match(readRepo(".pi/agents/trial-report-writer.md"), /Every attorney-review checklist line must begin exactly/);
});

test("persistent case team bounds living state and scores only the incoming batch", () => {
  const wf = YAML.parse(readRepo(".pi/workflows/persistent-case-team.yaml"));
  const guards = YAML.parse(wf.doc.split("```orchestrator-guards")[1].split("```")[0]);
  assert.deepEqual(guards.checks[0].record, ["{params.target}"], "generated record cannot support itself");
  const inventory = wf.flow.steps.find((s: { label?: string }) => s.label === "inventory");
  assert.match(inventory.task, /Exclude README\/index files/);
  const teams = wf.flow.steps.find((s: { label?: string }) => s.label === "matter-teams");
  assert.match(teams.branches.entities.task, /stay under 2,000 words/);
  assert.match(teams.branches.timeline.task, /Use only exact stated dates/);
  assert.match(teams.branches.documents.task, /Use `not stated` rather than infer/);
  const record = wf.flow.steps.find((s: { label?: string }) => s.label === "record-writer");
  assert.match(record.task, /complete record must stay under 1,800 words/);
  assert.match(record.task, /THE WRITTEN FILE MUST HAVE EXACTLY this structure/);
  assert.match(record.task, /After writing, read the file back and correct/);
  assert.match(record.task, /Timeline includes ONLY events with an exact date/);
  const validator = wf.flow.steps.find((s: { label?: string }) => s.label === "record-validator");
  assert.equal(validator.profile, "matter-record-validator");
  assert.match(validator.task, /preserve range endpoints/);
  assert.match(validator.task, /Updated: generated locally/);
  assert.match(validator.task, /number of distinct document-index rows in the completed record/);
  const report = wf.flow.steps.find((s: { label?: string }) => s.label === "report");
  assert.equal(report.profile, "matter-report-writer");
  assert.match(report.task, /Every factual statement\s+must cite an exact incoming path/);
  assert.match(report.task, /every checklist line MUST begin exactly/);
  const guard = wf.flow.steps.find((s: { label?: string }) => s.label === "quality-guards");
  assert.equal(guard.kind, "value");
  assert.match(guard.value, /Pending local scorecard/);
  for (const name of ["matter-entity-extractor", "matter-timeline-extractor", "matter-document-indexer", "matter-record-writer", "matter-record-validator", "matter-report-writer"]) {
    assert.match(readRepo(`.pi/agents/${name}.md`), /thinking: off/);
  }
  assert.match(readRepo(".pi/agents/matter-report-writer.md"), /LOW is only an administrative completeness gap/);
  assert.match(readRepo(".pi/agents/matter-record-writer.md"), /Never derive interest, totals, percentages/);
  assert.match(readRepo(".pi/agents/matter-report-writer.md"), /wage claims, and an open government audit are HIGH/);
  assert.match(readRepo(".pi/agents/matter-report-writer.md"), /document's issue date separate from dates of events/);
});
