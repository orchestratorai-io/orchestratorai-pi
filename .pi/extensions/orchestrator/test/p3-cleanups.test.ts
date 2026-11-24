// Tests for the P3 items of the 2026-11-23 Omarchy review that live in the
// extension: a finished run's node names are forgotten, and the final report
// falls back to the row's `display` when this Pi never saw run_created (20);
// resume ordinals read 1st/2nd/3rd and 11th-13th (23).
// Run: npm test (from .pi/extensions/orchestrator).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunStore } from "../store.ts";
import { Journal, ordinal, rememberedNodeNames, type AgentsApi } from "../journal.ts";

const PID = 4242;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-p3-test-"));
  const db = new RunStore(dir);
  const agents: AgentsApi = { async start() { return { runId: "unused" }; } };
  const journal = new Journal(() => db, agents, { pid: PID, pidAlive: () => true, ownerExitWaitMs: 0 });
  const cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, journal, cleanup };
}

test("run_completed forgets that run's node names and keeps other runs'", () => {
  const { db, journal, cleanup } = setup();
  try {
    for (const [id, pi] of [["run-a", "pi-a"], ["run-b", "pi-b"]]) {
      db.createRun({ id, workflow: "contract-review", title: id, params: { run_id: id }, ownerPid: PID });
      db.markStarted(id, pi, PID);
      journal.onRunEvent({ type: "node_started", at: Date.now(), runId: pi, instance: "n1", path: "$.body.steps[0]", profile: "red-blue-review" });
      journal.onRunEvent({ type: "node_started", at: Date.now(), runId: pi, instance: "n2", path: "$.body.steps[1]", profile: "summary-writer" });
    }
    assert.equal(rememberedNodeNames("pi-a"), 2);
    journal.onRunEvent({ type: "run_completed", at: Date.now(), runId: "pi-a", status: "completed", value: "done", agents: 2 });
    assert.equal(rememberedNodeNames("pi-a"), 0);
    assert.equal(rememberedNodeNames("pi-b"), 2);
    journal.onRunEvent({ type: "run_completed", at: Date.now(), runId: "pi-b", status: "completed", value: "done", agents: 2 });
    assert.equal(rememberedNodeNames("pi-b"), 0);
  } finally {
    cleanup();
  }
});

test("final report uses the row's display when the run header is not known", () => {
  const { db, journal, cleanup } = setup();
  try {
    db.createRun({ id: "run-e", workflow: "document-onboarding", title: "Onboard", params: { run_id: "run-e" }, ownerPid: PID });
    db.markStarted("run-e", "pi-e", PID);
    db.setFlow("run-e", { kind: "workflow", name: "document-onboarding" }, "summary.markdown");
    journal.onRunEvent({
      type: "run_completed",
      at: Date.now(),
      runId: "pi-e",
      status: "completed",
      value: { summary: { markdown: "# Onboarding report" } },
      agents: 1,
    });
    assert.equal(db.getRun("run-e")?.result_markdown, "# Onboarding report");
  } finally {
    cleanup();
  }
});

test("resume ordinals", () => {
  const cases: Array<[number, string]> = [
    [1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"], [11, "11th"], [12, "12th"], [13, "13th"],
    [21, "21st"], [22, "22nd"], [23, "23rd"], [101, "101st"], [111, "111th"], [112, "112th"], [113, "113th"],
  ];
  for (const [n, want] of cases) assert.equal(ordinal(n), want);
});
