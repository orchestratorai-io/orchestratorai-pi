// Tests for the fixes from the 2026-11-23 Omarchy review of the resume work:
// safe concurrent resume (3), a fast run_completed is not undone (5),
// processAlive rejects non-positive pids (6). The reload/session-switch fix (2)
// is in runtime.test.ts. Run: npm test (from .pi/extensions/orchestrator).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunStore } from "../store.ts";
import { Journal, processAlive, type AgentsApi } from "../journal.ts";

const SELF_PID = 4242;
const OTHER_PID = 5151;

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

type StartParams = Parameters<AgentsApi["start"]>[0];

/** A store, and a journal whose pi-agents `start` is whatever the test says. */
function setup(start: (params: StartParams, runId: string, journal: Journal) => Promise<void>, opts: { alive?: Set<number>; ownerExitWaitMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-fixes-test-"));
  const db = new RunStore(dir);
  const starts: StartParams[] = [];
  let n = 0;
  let journal: Journal;
  const agents: AgentsApi = {
    async start(params) {
      starts.push(params);
      const runId = `pi-${++n}`;
      await start(params, runId, journal);
      return { runId };
    },
  };
  const alive = opts.alive ?? new Set([SELF_PID]);
  journal = new Journal(() => db, agents, { pid: SELF_PID, pidAlive: (pid) => alive.has(pid), ownerExitWaitMs: opts.ownerExitWaitMs ?? 0 });
  const cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, journal, starts, alive, cleanup };
}

function header(params: StartParams, runId: string) {
  return {
    id: runId,
    label: params.label,
    source: { kind: params.flow ? "inline" : "workflow", workflow: params.workflow },
    params: params.params,
    flow: params.flow ?? { ...FLOW, params: params.params },
  };
}

/** Like pi-agents 0.21: run_created inside `start`, before the reply. */
const emitsCreated = async (params: StartParams, runId: string, journal: Journal) => {
  journal.onRunEvent({ type: "run_created", at: Date.now(), run: header(params, runId) });
};

/** A run that finished step 1 and then stopped, owned by `ownerPid`. */
function stoppedRun(db: RunStore, id: string, title: string, ownerPid: number) {
  db.createRun({ id, workflow: "contract-review", title, params: { run_id: id, document: "nda.md" }, model: "qwen3.6:35b-mlx", ownerPid });
  db.markStarted(id, `pi-original-${id}`, ownerPid);
  db.setFlow(id, FLOW, undefined);
  db.appendEvent({ runId: id, type: "node_completed", summary: "Completed red-blue-review", nodePath: "$.body.steps[0]", value: "findings", stepIndex: 0 });
  db.markFinished(id, { status: "stopped", error: "Pi exited before the workflow finished." });
}

function runIds(db: RunStore): string[] {
  return ((db as any).db.prepare("SELECT id FROM runs ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
}

function beatNow(db: RunStore, id: string) {
  (db as any).db.prepare("UPDATE runs SET heartbeat_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

// ---- 3. Journal.resume re-reads the run after waiting, and is safe to call twice at once

test("resume re-reads the run after waiting for the previous Pi, and refuses it if that Pi completed it", async () => {
  const { db, journal, starts, alive, cleanup } = setup(emitsCreated, { ownerExitWaitMs: 3_000 });
  try {
    stoppedRun(db, "run-1", "NDA", OTHER_PID);
    beatNow(db, "run-1");
    alive.add(OTHER_PID);
    setTimeout(() => {
      // The previous Pi finishes the run, then exits, while resume waits.
      db.markFinished("run-1", { status: "completed", resultMarkdown: "done" });
      alive.delete(OTHER_PID);
    }, 300);
    await assert.rejects(journal.resume(db, { runId: "run-1" }), /already completed/);
    assert.equal(starts.length, 0, "a completed run was started again");
    assert.equal(db.getRun("run-1")!.status, "completed");
  } finally {
    cleanup();
  }
});

test("resume counts resumes from the row as it is after the wait, not before it", async () => {
  const { db, journal, alive, cleanup } = setup(emitsCreated, { ownerExitWaitMs: 3_000 });
  try {
    stoppedRun(db, "run-1", "NDA", OTHER_PID);
    beatNow(db, "run-1");
    alive.add(OTHER_PID);
    setTimeout(() => {
      // The previous Pi had resumed it once more before it exited.
      (db as any).db.prepare("UPDATE runs SET resumes = 2 WHERE id = 'run-1'").run();
      alive.delete(OTHER_PID);
    }, 300);
    assert.equal((await journal.resume(db, { runId: "run-1" })).ok, true);
    const summary = (db as any).db.prepare("SELECT summary FROM run_events WHERE run_id = 'run-1' AND type = 'resume'").get().summary;
    assert.match(summary, /3rd resume/);
  } finally {
    cleanup();
  }
});

test("two near-simultaneous resumes of one run in this Pi start it once", async () => {
  const { db, journal, starts, alive, cleanup } = setup(emitsCreated, { ownerExitWaitMs: 3_000 });
  try {
    stoppedRun(db, "run-1", "NDA", OTHER_PID);
    beatNow(db, "run-1");
    alive.add(OTHER_PID); // both resumes have to wait, which is where the old race was
    setTimeout(() => alive.delete(OTHER_PID), 300);
    const [a, b] = await Promise.allSettled([journal.resume(db, { runId: "run-1" }), journal.resume(db, { runId: "run-1" })]);
    const ok = [a, b].filter((r) => r.status === "fulfilled" && (r.value as any).ok);
    const refused = [a, b].filter((r) => r.status === "rejected");
    assert.equal(ok.length, 1);
    assert.equal(refused.length, 1);
    assert.match(String((refused[0] as PromiseRejectedResult).reason), /already running in this Pi/);
    assert.equal(starts.length, 1, "the run was started twice");
  } finally {
    cleanup();
  }
});

test("two resumes of different runs in flight at once each land on their own run", async () => {
  // pi-agents' start replies later; both resumes are pending when each run_created arrives.
  const { db, journal, cleanup } = setup(async (params, runId, j) => {
    await new Promise((r) => setTimeout(r, 50));
    j.onRunEvent({ type: "run_created", at: Date.now(), run: header(params, runId) });
    await new Promise((r) => setTimeout(r, 50));
  });
  try {
    stoppedRun(db, "run-a", "NDA for Acme", OTHER_PID);
    stoppedRun(db, "run-b", "NDA for Beta", OTHER_PID);
    const [a, b] = await Promise.all([journal.resume(db, { runId: "run-a" }), journal.resume(db, { runId: "run-b" })]);
    assert.equal(a.ok, true, String(a.error));
    assert.equal(b.ok, true, String(b.error));
    assert.deepEqual(runIds(db), ["run-a", "run-b"], "a resume created a junk run row");
    assert.equal(db.getRun("run-a")!.pi_run_id, a.piRunId);
    assert.equal(db.getRun("run-b")!.pi_run_id, b.piRunId);
    assert.equal(db.getRun("run-a")!.resumes, 1);
    assert.equal(db.getRun("run-b")!.resumes, 1);
    assert.deepEqual(journal.liveRunIds().sort(), ["run-a", "run-b"]);
  } finally {
    cleanup();
  }
});

// ---- 5. A run_completed that arrives before `start` replies is not undone

const failsAtOnce = async (params: StartParams, runId: string, journal: Journal) => {
  journal.onRunEvent({ type: "run_created", at: Date.now(), run: header(params, runId) });
  journal.onRunEvent({ type: "run_completed", at: Date.now(), runId, status: "failed", error: "model not found" });
};

test("a start that fails at once stays failed: not marked running, not heartbeated", async () => {
  const { db, journal, cleanup } = setup(failsAtOnce);
  try {
    const reply = await journal.start(db, { workflow: "contract-review", title: "NDA" }, undefined);
    assert.equal(reply.ok, true);
    const row = db.getRun(reply.runId as string)!;
    assert.equal(row.status, "failed");
    assert.equal(row.heartbeat_at, null);
    assert.deepEqual(journal.liveRunIds(), []);
    journal.heartbeat();
    assert.equal(db.getRun(row.id)!.heartbeat_at, null, "a finished run was heartbeated");
  } finally {
    cleanup();
  }
});

test("a resume that fails at once stays failed and can be resumed again", async () => {
  const { db, journal, starts, cleanup } = setup(failsAtOnce);
  try {
    stoppedRun(db, "run-1", "NDA", OTHER_PID);
    assert.equal((await journal.resume(db, { runId: "run-1" })).ok, true);
    const row = db.getRun("run-1")!;
    assert.equal(row.status, "failed");
    assert.equal(row.heartbeat_at, null);
    assert.deepEqual(journal.liveRunIds(), []);
    assert.equal((await journal.resume(db, { runId: "run-1" })).ok, true, "a later resume was blocked");
    assert.equal(starts.length, 2);
  } finally {
    cleanup();
  }
});

// ---- 6. processAlive rejects pids that are not positive integers

test("processAlive is false for 0, negative and non-integer pids", () => {
  for (const pid of [0, -1, -process.pid, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(processAlive(pid), false, `pid ${pid}`);
  }
  assert.equal(processAlive(process.pid), true);
});
