// Tests for the remaining P2 items of the 2026-11-23 Pi review:
//   9. resume rebind nodes get no step_index (wrong step numbers, broken Revert)
//  10. updateState() and the migration loop run in BEGIN IMMEDIATE transactions
//  11. the finished mark and the final_review checkpoint are written together
// Items 5 and 8 are app-side; see Tests/PiTests/OverridesStopResumeTests.swift.
// Run: npm test (from .pi/extensions/orchestrator).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { RunStore } from "../store.ts";
import { Journal, buildResumeFlow, topLevelStepIndex, type AgentsApi } from "../journal.ts";

const SELF_PID = 4242;
const OTHER_PID = 5151;
const STORE_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "store.ts");

/** Three steps; the first has no `as:`, so a resume re-binds fewer steps than it skips. */
const FLOW = {
  kind: "workflow",
  name: "three-step",
  params: { run_id: "" },
  body: {
    kind: "sequence",
    steps: [
      { kind: "agent", profile: "intake", task: "Read {params.document}" },
      { kind: "agent", profile: "inventory", task: "List the clauses", as: "inventory" },
      { kind: "agent", profile: "writer", task: "Write up {inventory}", as: "report" },
    ],
  },
};

function tempDir(tag: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-${tag}-`));
}

function stepEvents(db: RunStore, runId: string): Array<{ step_index: number | null; value_json: string | null; label: string | null }> {
  return (db as any).db
    .prepare("SELECT step_index, value_json, label FROM run_events WHERE run_id = ? AND type = 'node_completed' ORDER BY seq")
    .all(runId);
}

// ---- 9. Resume rebind nodes and step_index

test("topLevelStepIndex gives resume:* rebind nodes no index and maps the rest through the offset", () => {
  assert.equal(topLevelStepIndex("$.body.steps[2]", 0), 2);
  // Resumed flow: 1 rebind node, then original step 2 at $.steps[1] (offset 1).
  assert.equal(topLevelStepIndex("$.steps[0]", 1, 1), undefined);
  assert.equal(topLevelStepIndex("$.steps[1]", 1, 1), 2);
  assert.equal(topLevelStepIndex("$.steps[1].body", 1, 1), undefined);
});

test("a resume after a step with no `as:` files only the new step, and leaves the stored step values for Revert", async () => {
  const dir = tempDir("rebind");
  const db = new RunStore(dir);
  let journal: Journal;
  const agents: AgentsApi = {
    async start(params) {
      const runId = "pi-resumed";
      journal.onRunEvent({
        type: "run_created",
        at: Date.now(),
        run: { id: runId, label: params.label, source: { kind: "inline" }, flow: params.flow as never },
      });
      // The rebind node: like a real one after an extension reload, its node_started label
      // is not known, so only its position in the flow says it is a rebind.
      journal.onRunEvent({ type: "node_completed", runId, path: "$.steps[0]", instance: "r0", kind: "value", value: { clauses: ["edited"] } });
      // Original step 2, the first step this resume actually runs.
      journal.onRunEvent({ type: "node_started", runId, path: "$.steps[1]", instance: "s2", kind: "agent", profile: "writer" });
      journal.onRunEvent({ type: "node_completed", runId, path: "$.steps[1]", instance: "s2", value: "the report" });
      return { runId };
    },
  };
  journal = new Journal(() => db, agents, { pid: SELF_PID, pidAlive: () => false, ownerExitWaitMs: 0 });
  try {
    db.createRun({ id: "run-9", workflow: "three-step", title: "Three step", params: { run_id: "run-9", document: "nda.md" }, ownerPid: OTHER_PID });
    db.markStarted("run-9", "pi-original", OTHER_PID);
    db.setFlow("run-9", FLOW, undefined);
    db.appendEvent({ runId: "run-9", type: "node_completed", summary: "Completed intake", nodePath: "$.body.steps[0]", value: "intake notes", stepIndex: 0 });
    db.appendEvent({ runId: "run-9", type: "node_completed", summary: "Completed inventory", nodePath: "$.body.steps[1]", value: { clauses: ["original"] }, stepIndex: 1 });
    db.markFinished("run-9", { status: "stopped" });
    // The attorney edited step 2 (index 1) before resuming.
    (db as any).db
      .prepare("INSERT INTO step_overrides (run_id, step_index, value_json, note, at) VALUES (?, ?, ?, NULL, ?)")
      .run("run-9", 1, JSON.stringify({ clauses: ["edited"] }), new Date().toISOString());

    const built = buildResumeFlow(db.getRun("run-9")!, db.completedStepValues("run-9"), db.stepOverrides("run-9"));
    assert.equal(built.resumeAt, 2);
    assert.equal(built.rebinds, 1);
    assert.equal(built.resumeOffset, 1);

    const reply = await journal.resume(db, { runId: "run-9" });
    assert.equal(reply.ok, true, String(reply.error));
    assert.equal(db.getRun("run-9")!.resume_rebinds, 1);

    const events = stepEvents(db, "run-9");
    // Before the fix the rebind landed on step 1 (0 + offset 1) with the edited value.
    assert.deepEqual(events.map((e) => e.step_index), [0, 1, null, 2]);
    const values = db.completedStepValues("run-9");
    assert.deepEqual(values.get(1), { clauses: ["original"] }, "Revert would no longer restore the original output");
    assert.equal(values.get(2), "the report");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 10. Transactions

test("transaction() rolls back everything when its body throws, and nests by joining", () => {
  const dir = tempDir("tx");
  const db = new RunStore(dir);
  try {
    db.createRun({ id: "run-10", workflow: "w", title: "t", params: {} });
    assert.throws(() =>
      db.transaction(() => {
        db.updateState("run-10", "notes", "append", "first");
        throw new Error("boom");
      }),
    /boom/);
    assert.deepEqual(db.getState("run-10"), {}, "the write inside the failed transaction was kept");
    // updateState inside an outer transaction joins it rather than failing on a nested BEGIN.
    db.transaction(() => {
      db.updateState("run-10", "notes", "append", "a");
      db.updateState("run-10", "notes", "append", "b");
    });
    assert.deepEqual(db.getState("run-10", "notes"), { notes: ["a", "b"] });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs `code` in `n` separate node processes at once (each its own SQLite connection). */
async function inParallel(n: number, code: string, args: string[]): Promise<void> {
  const runs = Array.from({ length: n }, (_, i) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code, STORE_TS, String(i), ...args], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("exit", (status) => (status === 0 ? resolve() : reject(new Error(`child ${i} exited ${status}: ${stderr}`))));
    }),
  );
  await Promise.all(runs);
}

test("parallel agents appending to one state key through separate connections lose no writes", async () => {
  const dir = tempDir("state-race");
  const db = new RunStore(dir);
  db.createRun({ id: "run-10", workflow: "w", title: "t", params: {} });
  db.close();
  const PROCS = 4;
  const EACH = 40;
  const code = `
    const [storeTs, who, dir, each] = process.argv.slice(1);
    const { RunStore } = await import(storeTs);
    const db = new RunStore(dir);
    for (let i = 0; i < Number(each); i++) db.updateState("run-10", "findings", "append", who + ":" + i);
    db.close();
  `;
  try {
    await inParallel(PROCS, code, [dir, String(EACH)]);
    const check = new RunStore(dir);
    const findings = check.getState("run-10", "findings").findings as string[];
    const version = ((check as any).db.prepare("SELECT version FROM run_state WHERE run_id = 'run-10' AND key = 'findings'").get() as { version: number }).version;
    check.close();
    assert.equal(findings.length, PROCS * EACH, "an append was lost");
    assert.equal(new Set(findings).size, PROCS * EACH);
    assert.equal(version, PROCS * EACH);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("several Pis opening an old store at once all migrate it without a duplicate-column error", async () => {
  const dir = tempDir("migrate-race");
  fs.mkdirSync(path.join(dir, "data"));
  // A store from before every migrated column existed.
  const old = new DatabaseSync(path.join(dir, "data", "orchestrator.sqlite"));
  old.exec("PRAGMA journal_mode = WAL;");
  old.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, title TEXT NOT NULL, source_document TEXT,
    params_json TEXT NOT NULL, model TEXT, pi_run_id TEXT, status TEXT NOT NULL, error TEXT, result_markdown TEXT,
    result_json TEXT, agents INTEGER, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE run_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL,
    node_path TEXT, node_instance TEXT, node_kind TEXT, agent TEXT, label TEXT, summary TEXT NOT NULL, detail TEXT, payload_json TEXT);`);
  old.close();
  const code = `
    const [storeTs, who, dir] = process.argv.slice(1);
    const { RunStore } = await import(storeTs);
    new RunStore(dir).close();
  `;
  try {
    await inParallel(6, code, [dir]);
    const check = new RunStore(dir);
    const cols = ((check as any).db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name);
    check.close();
    for (const c of ["flow_json", "resume_offset", "owner_pid", "origin", "resume_rebinds"]) assert.ok(cols.includes(c), `missing ${c}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 11. Finished mark and final review together

function checkpoints(db: RunStore, runId: string): Array<{ kind: string; status: string; summary_markdown: string | null }> {
  // node:sqlite rows have a null prototype; copy them so deepEqual compares fields only.
  return ((db as any).db.prepare("SELECT kind, status, summary_markdown FROM checkpoints WHERE run_id = ? ORDER BY rowid").all(runId) as object[]).map((r) => ({ ...r })) as never;
}

test("a completed run gets its pending final review in the same write as its finished mark", () => {
  const dir = tempDir("finish");
  const db = new RunStore(dir);
  try {
    db.createRun({ id: "run-11", workflow: "w", title: "t", params: {} });
    db.markStarted("run-11", "pi-11");
    db.finishRun("run-11", { status: "completed", resultMarkdown: "# Report" }, { checkpointId: "final-1" });
    assert.equal(db.getRun("run-11")!.status, "completed");
    assert.deepEqual(checkpoints(db, "run-11"), [{ kind: "final_review", status: "pending", summary_markdown: "# Report" }]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("if the final review cannot be written, the run is not marked completed either", () => {
  const dir = tempDir("finish-fail");
  const db = new RunStore(dir);
  try {
    db.createRun({ id: "run-11", workflow: "w", title: "t", params: {} });
    db.markStarted("run-11", "pi-11");
    // A checkpoint id that already exists makes the insert fail after markFinished ran.
    db.createCheckpoint({ id: "taken", runId: "other-run", kind: "gate", title: "x" });
    assert.throws(() => db.finishRun("run-11", { status: "completed", resultMarkdown: "# Report" }, { checkpointId: "taken" }));
    assert.equal(db.getRun("run-11")!.status, "running", "completed without a final review: stuck in Needs attention");
    assert.deepEqual(checkpoints(db, "run-11"), []);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed run's finish cancels its open gates and creates no final review", () => {
  const dir = tempDir("finish-failed");
  const db = new RunStore(dir);
  try {
    db.createRun({ id: "run-11", workflow: "w", title: "t", params: {} });
    db.createCheckpoint({ id: "gate-1", runId: "run-11", kind: "gate", title: "Approve?" });
    db.finishRun("run-11", { status: "failed", error: "model gone" }, { checkpointId: "final-1" });
    assert.equal(db.getRun("run-11")!.status, "failed");
    assert.deepEqual(checkpoints(db, "run-11").map((c) => [c.kind, c.status]), [["gate", "cancelled"]]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the journal's run_completed goes through finishRun", () => {
  const dir = tempDir("journal-finish");
  const db = new RunStore(dir);
  const journal = new Journal(() => db, { async start() { return { runId: "x" }; } }, { pid: SELF_PID });
  try {
    journal.onRunEvent({ type: "run_created", at: Date.now(), run: { id: "pi-11", label: "Doc", source: { kind: "workflow", workflow: "w" } } });
    journal.onRunEvent({ type: "run_completed", runId: "pi-11", status: "completed", value: { report: "# Done" }, agents: 2 });
    const row = db.findRunByPiId("pi-11")!;
    assert.equal(row.status, "completed");
    assert.deepEqual(checkpoints(db, row.id), [{ kind: "final_review", status: "pending", summary_markdown: "# Done" }]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
