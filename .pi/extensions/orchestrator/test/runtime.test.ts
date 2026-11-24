// Tests for the process-wide store link and heartbeat across a reload or
// session switch (review finding 2). Run: npm test (from .pi/extensions/orchestrator).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunStore } from "../store.ts";
import { Journal, type AgentsApi } from "../journal.ts";
import { endsProcess, ExtensionRuntime } from "../runtime.ts";

const SELF_PID = 4242;
const OLD = "2026-01-01T00:00:00.000Z";

const FLOW = { kind: "workflow", name: "contract-review", params: { run_id: "" }, body: { kind: "sequence", steps: [{ kind: "agent", profile: "x", task: "t", as: "a" }] } };

/** One copy of the extension, as index.ts builds it: a journal reading the shared store. */
function copy(key: symbol, opened: RunStore[], heartbeatMs = 1_000_000) {
  let n = 0;
  let runtime: ExtensionRuntime | undefined;
  let journal: Journal;
  const agents: AgentsApi = {
    async start(params) {
      const runId = `pi-${key.description}-${++n}`;
      journal.onRunEvent({ type: "run_created", at: Date.now(), run: { id: runId, label: params.label, source: { kind: "workflow", workflow: params.workflow }, params: params.params, flow: { ...FLOW, params: params.params } } });
      return { runId };
    },
  };
  journal = new Journal(() => runtime?.store, agents, { pid: SELF_PID, pidAlive: () => true });
  runtime = new ExtensionRuntime(journal, {
    key,
    heartbeatMs,
    openStore: (dir) => {
      const db = new RunStore(dir);
      opened.push(db);
      return db;
    },
  });
  return { journal, runtime };
}

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-test-"));
}

function heartbeatOf(db: RunStore, id: string): string | null {
  return db.getRun(id)!.heartbeat_at;
}

test("session_shutdown reasons: only quit (or a missing/unknown reason) ends the process", () => {
  assert.equal(endsProcess("quit"), true);
  for (const reason of ["reload", "new", "resume", "fork"]) assert.equal(endsProcess(reason), false, reason);
  assert.equal(endsProcess(undefined), true);
  assert.equal(endsProcess("something-new"), true);
});

test("a reload keeps the store open and the run heartbeating; the new copy re-adopts the run; quit releases it", async () => {
  const key = Symbol("reload");
  const dir = tempProject();
  const opened: RunStore[] = [];
  try {
    const first = copy(key, opened, 20);
    assert.equal(first.runtime.inherited, false);
    const db = first.runtime.sessionStore(dir);
    const started = await first.journal.start(db, { workflow: "contract-review", title: "NDA" }, undefined);
    const runId = started.runId as string;
    assert.deepEqual(first.journal.liveRunIds(), [runId]);

    // /reload: the old copy gets session_shutdown("reload"); Pi then loads a new copy.
    assert.equal(first.runtime.shutdown("reload"), false);
    assert.ok(first.runtime.store, "the store was closed on reload");
    const second = copy(key, opened, 20);
    assert.equal(second.runtime.inherited, true);
    assert.deepEqual(second.journal.liveRunIds(), [runId], "the new copy did not re-adopt the run");

    // A run event before the new copy's session_start still lands (nothing was closed).
    second.journal.onRunEvent({ type: "node_started", runId: started.piRunId, path: "$.body.steps[0]", instance: "n0", kind: "agent", profile: "x" });
    const events = (db as any).db.prepare("SELECT type FROM run_events WHERE run_id = ?").all(runId).map((e: any) => e.type);
    assert.ok(events.includes("node_started"), `events: ${events.join(",")}`);

    // The run waits at a gate, writing nothing: the surviving timer keeps its heartbeat fresh.
    second.runtime.sessionStore(dir);
    assert.equal(opened.length, 1, "the store was reopened");
    (db as any).db.prepare("UPDATE runs SET heartbeat_at = ? WHERE id = ?").run(OLD, runId);
    await new Promise((r) => setTimeout(r, 80));
    assert.notEqual(heartbeatOf(db, runId), OLD, "heartbeat stopped after the reload");

    // Pi quits: the run is released, the timer stopped, the store closed.
    assert.equal(second.runtime.shutdown("quit"), true);
    assert.equal(second.runtime.store, undefined);
    assert.equal((globalThis as any)[key], undefined);
    const check = new RunStore(dir);
    try {
      assert.equal(heartbeatOf(check, runId), null);
    } finally {
      check.close();
    }
  } finally {
    for (const db of opened) try { db.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const reason of ["new", "resume", "fork"]) {
  test(`a session switch (${reason}) keeps the store and lets the new copy re-adopt the run`, async () => {
    const key = Symbol(`switch-${reason}`);
    const dir = tempProject();
    const opened: RunStore[] = [];
    try {
      const first = copy(key, opened);
      const db = first.runtime.sessionStore(dir);
      const started = await first.journal.start(db, { workflow: "contract-review", title: "NDA" }, undefined);
      assert.equal(first.runtime.shutdown(reason), false);
      const second = copy(key, opened);
      second.runtime.sessionStore(dir);
      assert.deepEqual(second.journal.liveRunIds(), [started.runId]);
      assert.ok(heartbeatOf(db, started.runId as string), "the run was released on a session switch");
      second.runtime.shutdown("quit");
    } finally {
      for (const db of opened) try { db.close(); } catch { /* already closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a fresh Pi process does not adopt rows that only share its pid (a reused pid)", () => {
  const key = Symbol("fresh");
  const dir = tempProject();
  const opened: RunStore[] = [];
  try {
    const seed = new RunStore(dir);
    seed.createRun({ id: "ghost", workflow: "contract-review", title: "Old", params: {}, ownerPid: SELF_PID });
    seed.markStarted("ghost", "pi-ghost", SELF_PID); // an earlier Pi with this pid died without releasing it
    seed.close();
    const only = copy(key, opened);
    assert.equal(only.runtime.inherited, false);
    only.runtime.sessionStore(dir);
    assert.deepEqual(only.journal.liveRunIds(), []);
    only.runtime.shutdown("quit");
  } finally {
    for (const db of opened) try { db.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("adopt skips runs this process finished or released", async () => {
  const dir = tempProject();
  const db = new RunStore(dir);
  try {
    const journal = new Journal(() => db, { async start() { return { runId: "x" }; } }, { pid: SELF_PID });
    for (const id of ["live", "done", "released"]) {
      db.createRun({ id, workflow: "w", title: id, params: {}, ownerPid: SELF_PID });
      db.markStarted(id, `pi-${id}`, SELF_PID);
    }
    db.markFinished("done", { status: "failed", error: "x" });
    (db as any).db.prepare("UPDATE runs SET heartbeat_at = NULL WHERE id = 'released'").run();
    assert.equal(journal.adopt(), 1);
    assert.deepEqual(journal.liveRunIds(), ["live"]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
