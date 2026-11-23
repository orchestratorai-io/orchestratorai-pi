// Tests for the run journal and resume. Run: npm test (from .pi/extensions/orchestrator).
//
// A fake pi-agents `start` plays the engine: like pi-agents 0.21 it emits
// run_created (and here the first step events) synchronously inside `start`,
// before the reply. Every case uses a throwaway store in a temp folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunStore } from "../store.ts";
import { HEARTBEAT_STALE_MS, Journal, LEGACY_STALE_MS, stillRunningReason, type AgentsApi } from "../journal.ts";

const SELF_PID = 4242;
const OTHER_PID = 5151;

/** A two-step saved workflow as pi-agents expands it: workflow root, sequence body. */
const FLOW = {
  kind: "workflow",
  name: "contract-review",
  params: { run_id: "" },
  body: {
    kind: "sequence",
    steps: [
      { kind: "agent", profile: "red-blue-review", task: "Review {params.document}", as: "review" },
      { kind: "agent", profile: "summary-writer", task: "Summarise {review}", as: "summary" },
    ],
  },
};

function setup(opts: { alive?: Set<number>; now?: () => number; ownerExitWaitMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-test-"));
  const db = new RunStore(dir);
  const starts: Array<{ flow?: unknown; workflow?: string; label?: string }> = [];
  let n = 0;
  let journal: Journal;
  const agents: AgentsApi = {
    async start(params) {
      starts.push(params);
      const runId = `pi-${++n}`;
      const header = {
        id: runId,
        label: params.label,
        source: { kind: params.flow ? "inline" : "workflow", workflow: params.workflow },
        params: params.params,
        flow: params.flow ?? { ...FLOW, params: params.params },
      };
      journal.onRunEvent({ type: "run_created", at: Date.now(), run: header });
      journal.onRunEvent({ type: "node_started", runId, path: "$.steps[0]", instance: "n0", kind: "value", label: "resume:review" });
      if (params.flow) {
        // The rebind node completes with the re-bound value; pi-agents' node_completed has no label.
        journal.onRunEvent({ type: "node_completed", runId, path: "$.steps[0]", instance: "n0", value: "findings (edited)" });
      }
      return { runId };
    },
  };
  const alive = opts.alive ?? new Set([SELF_PID]);
  journal = new Journal(() => db, agents, { pid: SELF_PID, pidAlive: (pid) => alive.has(pid), now: opts.now, ownerExitWaitMs: opts.ownerExitWaitMs ?? 0 });
  const cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, journal, starts, alive, cleanup };
}

/** A run the app started that finished step 1 and then lost its Pi. */
function stoppedRun(db: RunStore, ownerPid: number | undefined) {
  const run = db.createRun({ id: "run-1", workflow: "contract-review", title: "Contract Review — NDA", params: { run_id: "run-1", document: "nda.md" }, model: "qwen3.6:latest", ownerPid });
  db.markStarted(run.id, "pi-original", ownerPid);
  db.setFlow(run.id, FLOW, undefined);
  db.appendEvent({ runId: run.id, type: "node_completed", summary: "Completed red-blue-review", nodePath: "$.body.steps[0]", value: "findings", stepIndex: 0 });
  db.markFinished(run.id, { status: "stopped", error: "Pi exited before the workflow finished." });
  return db.getRun(run.id)!;
}

function allRuns(db: RunStore): Array<{ id: string; workflow: string; title: string }> {
  return (db as any).db.prepare("SELECT id, workflow, title FROM runs ORDER BY created_at").all();
}

// ---- 1. Resume creates junk runs

test("resume journals onto the run being resumed and creates no extra 'inline … (resumed)' run", async () => {
  const { db, journal, starts, cleanup } = setup();
  try {
    stoppedRun(db, OTHER_PID);
    const reply = await journal.resume(db, { runId: "run-1" });
    assert.equal(reply.ok, true, String(reply.error));
    assert.equal(starts.length, 1);
    assert.deepEqual(allRuns(db).map((r) => r.id), ["run-1"], "resume created a second run row");
    const row = db.getRun("run-1")!;
    assert.equal(row.status, "running");
    assert.equal(row.resumes, 1);
    assert.equal(row.pi_run_id, "pi-1");
    assert.equal(row.owner_pid, SELF_PID);
    // The events pi-agents emitted inside `start` landed on run-1.
    const types = ((db as any).db.prepare("SELECT type FROM run_events WHERE run_id = 'run-1' ORDER BY seq").all() as Array<{ type: string }>).map((e) => e.type);
    assert.ok(types.includes("run_created") && types.includes("node_started"), `events: ${types.join(",")}`);
    // The original flow is kept, not replaced by the resume flow: a second resume still works.
    assert.equal(JSON.parse(row.flow_json!).kind, "workflow");
  } finally {
    cleanup();
  }
});

// ---- 4. Resume does not check for an already-running run

test("a second resume of a run this Pi is already driving is refused", async () => {
  const { db, journal, starts, cleanup } = setup();
  try {
    stoppedRun(db, OTHER_PID);
    assert.equal((await journal.resume(db, { runId: "run-1" })).ok, true);
    await assert.rejects(journal.resume(db, { runId: "run-1" }), /already running in this Pi/);
    assert.equal(starts.length, 1, "a second copy was started");
  } finally {
    cleanup();
  }
});

test("resume is refused while another live Pi still drives the run, even if it reads 'stopped'", async () => {
  const { db, journal, starts, alive, cleanup } = setup();
  try {
    stoppedRun(db, OTHER_PID); // reads `stopped`, but its Pi is alive and still beating
    db.heartbeat(["run-1"], OTHER_PID);
    assert.ok(db.getRun("run-1")!.heartbeat_at, "the heartbeat must follow the owner, whatever the status");
    alive.add(OTHER_PID);
    await assert.rejects(journal.resume(db, { runId: "run-1" }), /still running in another Pi \(process 5151\)/);
    assert.equal(starts.length, 0);
    // Once that Pi is gone, the same resume goes through.
    alive.delete(OTHER_PID);
    assert.equal((await journal.resume(db, { runId: "run-1" })).ok, true);
    assert.equal(starts.length, 1);
  } finally {
    cleanup();
  }
});

test("liveness rules: dead owner, stale heartbeat (reused pid), released owner, legacy rows", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const base = { status: "running", owner_pid: OTHER_PID, heartbeat_at: iso(10_000), updated_at: iso(10_000) } as any;
  const ctx = { selfPid: SELF_PID, ownedHere: false, now, pidAlive: (pid: number) => pid === OTHER_PID };
  assert.ok(stillRunningReason(base, ctx));
  assert.equal(stillRunningReason(base, { ...ctx, pidAlive: () => false }), undefined, "dead owner");
  assert.equal(stillRunningReason({ ...base, heartbeat_at: iso(HEARTBEAT_STALE_MS + 1) }, ctx), undefined, "stale heartbeat");
  assert.equal(stillRunningReason({ ...base, heartbeat_at: null }, ctx), undefined, "owner shut down");
  assert.ok(stillRunningReason({ ...base, owner_pid: null }, ctx), "legacy row updated recently");
  assert.equal(stillRunningReason({ ...base, owner_pid: null, updated_at: iso(LEGACY_STALE_MS + 1) }, ctx), undefined, "legacy row gone quiet");
  assert.equal(stillRunningReason({ ...base, owner_pid: null, status: "stopped" }, ctx), undefined, "legacy stopped row");
});

test("a resume's re-bind nodes are not journalled as step completions (no wrong step numbers, overrides stay overrides)", async () => {
  const { db, journal, cleanup } = setup();
  try {
    stoppedRun(db, OTHER_PID);
    await journal.resume(db, { runId: "run-1" });
    const values = db.completedStepValues("run-1");
    assert.deepEqual([...values.entries()], [[0, "findings"]], "step 1 must keep its original stored output");
    // A second resume (after this one stops) still rebuilds from the right steps.
    journal.onRunEvent({ type: "run_completed", runId: "pi-1", status: "stopped" });
    const again = await journal.resume(db, { runId: "run-1" });
    assert.equal(again.ok, true, String(again.error));
    assert.equal(again.resumeAt, 1);
  } finally {
    cleanup();
  }
});

test("resume waits briefly for the previous Pi to exit instead of refusing at once", async () => {
  const { db, journal, alive, cleanup } = setup({ ownerExitWaitMs: 2_000 });
  try {
    stoppedRun(db, OTHER_PID);
    (db as any).db.prepare("UPDATE runs SET heartbeat_at = ? WHERE id = 'run-1'").run(new Date().toISOString());
    alive.add(OTHER_PID);
    setTimeout(() => alive.delete(OTHER_PID), 300); // the app's SIGTERM lands
    const reply = await journal.resume(db, { runId: "run-1" });
    assert.equal(reply.ok, true, String(reply.error));
  } finally {
    cleanup();
  }
});

// ---- 2. Runs marked stopped while still waiting: the owning Pi heartbeats

test("the Pi driving a run keeps its heartbeat fresh while the run waits, and drops it on shutdown", async () => {
  const { db, journal, cleanup } = setup();
  try {
    stoppedRun(db, OTHER_PID);
    await journal.resume(db, { runId: "run-1" });
    (db as any).db.prepare("UPDATE runs SET heartbeat_at = '2026-01-01T00:00:00.000Z' WHERE id = 'run-1'").run();
    journal.heartbeat(); // what the HEARTBEAT_MS timer calls; no journal event is needed
    const beat = Date.parse(db.getRun("run-1")!.heartbeat_at!);
    assert.ok(Date.now() - beat < 5_000, "heartbeat was not refreshed");
    journal.release();
    assert.equal(db.getRun("run-1")!.heartbeat_at, null);
  } finally {
    cleanup();
  }
});

// ---- 6. Resume honours a hand-picked model

test("resume records the model picked in the app instead of keeping the old default", async () => {
  const { db, journal, cleanup } = setup();
  try {
    stoppedRun(db, OTHER_PID);
    const reply = await journal.resume(db, { runId: "run-1", model: "qwen3.6:35b-mlx" });
    assert.equal(reply.ok, true);
    assert.equal(reply.model, "qwen3.6:35b-mlx");
    assert.equal(db.getRun("run-1")!.model, "qwen3.6:35b-mlx");
    const resumeEvent = (db as any).db.prepare("SELECT summary FROM run_events WHERE run_id = 'run-1' AND type = 'resume'").get();
    assert.match(resumeEvent.summary, /1st resume on qwen3\.6:35b-mlx/);
  } finally {
    cleanup();
  }
});

test("resume without a model keeps the run's model", async () => {
  const { db, journal, cleanup } = setup();
  try {
    stoppedRun(db, OTHER_PID);
    await journal.resume(db, { runId: "run-1", model: "  " });
    assert.equal(db.getRun("run-1")!.model, "qwen3.6:latest");
  } finally {
    cleanup();
  }
});
