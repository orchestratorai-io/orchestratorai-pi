// Tests for the attorney_review gate. Run: npm test (from .pi/extensions/orchestrator).
//
// Each case uses a throwaway store in a temp folder and plays the app's part by
// writing the attorney's decision straight into the checkpoints table, the way
// Sources/Pi/RunStore.swift decide() does.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RunStore, STORE_RELATIVE_PATH, type RunRow } from "../store.ts";
import { attorneyGate, consoleAttached, gateRun, SKIPPED, type GateResult } from "../gate.ts";

const OPTS = { pollMs: 10, maxWaitMs: 60_000, newId: randomUUID };
const TITLE = "Cross-examination - answer as the witness";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gate-test-"));
  const db = new RunStore(dir);
  const run = db.createRun({ id: randomUUID(), workflow: "cross-exam-simulation", title: "Gate test", params: {} });
  // The app's own connection, used only to record decisions.
  const app = new DatabaseSync(path.join(dir, STORE_RELATIVE_PATH));
  const cleanup = () => {
    app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, run, app, cleanup };
}

/** Records an attorney decision on the one pending gate, as the app would. */
function decidePending(app: DatabaseSync, runId: string, status: string, comment: string): string {
  const pending = app
    .prepare("SELECT id FROM checkpoints WHERE run_id = ? AND kind = 'gate' AND status = 'pending'")
    .all(runId) as Array<{ id: string }>;
  assert.equal(pending.length, 1, `expected exactly one pending gate, found ${pending.length}`);
  const at = new Date().toISOString().replace(/\.\d+Z$/, "Z"); // Swift's ISO8601DateFormatter has no fractions
  app
    .prepare("UPDATE checkpoints SET status = ?, decision_comment = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
    .run(status, comment, at, pending[0].id);
  return pending[0].id;
}

/** Resolves to the gate's result, or to "still waiting" if it has not returned within `ms`. */
async function settle(p: Promise<GateResult>, ms = 200): Promise<GateResult | "still waiting"> {
  return Promise.race([p, new Promise<"still waiting">((r) => setTimeout(() => r("still waiting"), ms))]);
}

function text(r: GateResult | "still waiting"): string {
  return r === "still waiting" ? r : r.content[0].text;
}

/** One witness turn: the gate waits, the attorney answers, the step completes. */
async function turn(db: RunStore, app: DatabaseSync, run: RunRow, summary: string, answer: string) {
  const gate = attorneyGate(db, run, { title: TITLE, summary }, undefined, OPTS);
  const early = await settle(gate);
  assert.equal(early, "still waiting", `the gate returned without asking the attorney: ${text(early)}`);
  decidePending(app, run.id, "approved", answer);
  const result = await gate;
  db.appendEvent({ runId: run.id, type: "node_completed", summary: "witness-answer done", label: "witness-answer" });
  return text(result);
}

test("every cross-exam turn asks the attorney again, even with the same gate title", async () => {
  const { db, run, app, cleanup } = setup();
  try {
    for (let i = 1; i <= 5; i++) {
      const result = await turn(db, app, run, `**Q (turn ${i}):** Question ${i}?`, `answer ${i}`);
      assert.match(result, new RegExp(`COMMENT: answer ${i}$`));
    }
    const gates = app.prepare("SELECT status FROM checkpoints WHERE run_id = ? AND kind = 'gate'").all(run.id);
    assert.equal(gates.length, 5);
  } finally {
    cleanup();
  }
});

test("a later turn that repeats an earlier question still gets its own approval", async () => {
  const { db, run, app, cleanup } = setup();
  try {
    const summary = "**Q (lock-in, timeline):** You signed on March 3, correct?";
    assert.match(await turn(db, app, run, summary, "first"), /COMMENT: first$/);
    assert.match(await turn(db, app, run, summary, "second"), /COMMENT: second$/);
  } finally {
    cleanup();
  }
});

test("a duplicate call within the same step reuses the decision", async () => {
  const { db, run, app, cleanup } = setup();
  try {
    const params = { title: TITLE, summary: "**Q:** Same question?" };
    const first = attorneyGate(db, run, params, undefined, OPTS);
    assert.equal(await settle(first), "still waiting");
    decidePending(app, run.id, "approved", "once");
    assert.match(text(await first), /COMMENT: once$/);
    // The same agent calls the tool again before its step has finished.
    const again = await settle(attorneyGate(db, run, params, undefined, OPTS));
    assert.match(text(again), /DECISION: approved\nCOMMENT: once$/);
    assert.equal(app.prepare("SELECT id FROM checkpoints WHERE run_id = ?").all(run.id).length, 1);
  } finally {
    cleanup();
  }
});

test("after a resume, a decision delivered before the resume is not replayed", async () => {
  const { db, run, app, cleanup } = setup();
  try {
    const params = { title: TITLE, summary: "**Q:** Turn 1?" };
    const first = attorneyGate(db, run, params, undefined, OPTS);
    assert.equal(await settle(first), "still waiting");
    decidePending(app, run.id, "approved", "before resume");
    await first;
    // Pi stopped before the step finished; the run is resumed and asks the same question.
    db.appendEvent({ runId: run.id, type: "resume", summary: "Resuming from step 2" });
    const resumed = attorneyGate(db, run, params, undefined, OPTS);
    assert.equal(await settle(resumed), "still waiting");
    decidePending(app, run.id, "approved", "after resume");
    assert.match(text(await resumed), /COMMENT: after resume$/);
  } finally {
    cleanup();
  }
});

test("after a resume, a gate still pending for the same question is waited on, not duplicated", async () => {
  const { db, run, app, cleanup } = setup();
  try {
    const params = { title: TITLE, summary: "**Q:** Turn 3?" };
    const abort = new AbortController();
    const first = attorneyGate(db, run, params, abort.signal, OPTS);
    assert.equal(await settle(first), "still waiting");
    abort.abort(); // Pi went away while the attorney was still deciding
    await assert.rejects(first, /interrupted/);
    db.appendEvent({ runId: run.id, type: "resume", summary: "Resuming from step 2" });
    const resumed = attorneyGate(db, run, params, undefined, OPTS);
    assert.equal(await settle(resumed), "still waiting");
    decidePending(app, run.id, "approved", "decided late");
    assert.match(text(await resumed), /COMMENT: decided late$/);
    assert.equal(app.prepare("SELECT id FROM checkpoints WHERE run_id = ?").all(run.id).length, 1);
  } finally {
    cleanup();
  }
});

test("after a resume, a gate left pending for a different question is cancelled, not reused", async () => {
  const { db, run, app, cleanup } = setup();
  try {
    const abort = new AbortController();
    const old = attorneyGate(db, run, { title: TITLE, summary: "**Q:** Old turn 3?" }, abort.signal, OPTS);
    assert.equal(await settle(old), "still waiting");
    abort.abort();
    await assert.rejects(old, /interrupted/);
    db.appendEvent({ runId: run.id, type: "resume", summary: "Resuming from step 2" });
    // The resumed loop starts over with a newly generated question.
    const fresh = attorneyGate(db, run, { title: TITLE, summary: "**Q:** New turn 1?" }, undefined, OPTS);
    assert.equal(await settle(fresh), "still waiting");
    decidePending(app, run.id, "approved", "fresh answer"); // asserts only the new gate is pending
    assert.match(text(await fresh), /COMMENT: fresh answer$/);
    const rows = app
      .prepare("SELECT summary_markdown, status FROM checkpoints WHERE run_id = ? ORDER BY requested_at")
      .all(run.id) as Array<{ summary_markdown: string; status: string }>;
    assert.deepEqual(rows.map((r) => r.status), ["cancelled", "approved"]);
  } finally {
    cleanup();
  }
});

test("after a resume, a decision made while Pi was down is used, not asked again", async () => {
  const { db, run, app, cleanup } = setup();
  try {
    const params = { title: TITLE, summary: "**Q:** Turn 2?" };
    const abort = new AbortController();
    const first = attorneyGate(db, run, params, abort.signal, OPTS);
    assert.equal(await settle(first), "still waiting");
    abort.abort();
    await assert.rejects(first, /interrupted/);
    decidePending(app, run.id, "approved", "decided while down"); // no step has received it yet
    db.appendEvent({ runId: run.id, type: "resume", summary: "Resuming from step 2" });
    const resumed = await settle(attorneyGate(db, run, params, undefined, OPTS));
    assert.match(text(resumed), /DECISION: approved\nCOMMENT: decided while down$/);
  } finally {
    cleanup();
  }
});

test("a gate timeout times out only its own checkpoint; another pending approval stays decidable", async () => {
  const { db, run, app, cleanup } = setup();
  try {
    // Two agents in one run ask the attorney at the same time (parallel branches).
    const patient = attorneyGate(db, run, { title: "Approve the expert summary", summary: "Expert summary draft" }, undefined, OPTS);
    assert.equal(await settle(patient, 50), "still waiting");
    const hasty = attorneyGate(db, run, { title: "Approve the exhibit list", summary: "Exhibit list draft" }, undefined, { ...OPTS, maxWaitMs: 30 });

    const timedOut = await hasty;
    assert.match(text(timedOut), /^DECISION: timed_out/);
    const timedOutRow = db.getCheckpoint(timedOut.details.checkpointId as string)!;
    assert.equal(timedOutRow.status, "timed_out");

    // The other approval is still pending and the agent is still waiting on it.
    const pending = app
      .prepare("SELECT title FROM checkpoints WHERE run_id = ? AND kind = 'gate' AND status = 'pending'")
      .all(run.id) as Array<{ title: string }>;
    assert.deepEqual(pending.map((p) => p.title), ["Approve the expert summary"]);
    assert.equal(await settle(patient, 50), "still waiting");

    // And the attorney can still decide it.
    decidePending(app, run.id, "approved", "looks right");
    assert.equal(text(await patient), "DECISION: approved\nCOMMENT: looks right");
  } finally {
    cleanup();
  }
});

test("a decision recorded just as the gate times out is used, not cancelled", async () => {
  const { db, run, app, cleanup } = setup();
  try {
    // Hold the store's view of the checkpoint at "pending" for one read, as if the
    // attorney decided between the gate's last poll and its timeout.
    const realGet = db.getCheckpoint.bind(db);
    let raced = false;
    db.getCheckpoint = (id: string) => {
      const row = realGet(id);
      const asked = app.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND type = 'gate_requested'").get(run.id);
      if (row && asked && !raced) {
        raced = true;
        decidePending(app, run.id, "approved", "just in time");
        return { ...row, status: "pending" };
      }
      return row;
    };
    const result = await attorneyGate(db, run, { title: TITLE, summary: "Q?" }, undefined, { ...OPTS, maxWaitMs: -1 });
    assert.ok(raced, "the race was not staged");
    assert.equal(text(result), "DECISION: approved\nCOMMENT: just in time");
  } finally {
    cleanup();
  }
});

// ---- Terminal runs: no 12-hour wait (resume fix, item 5)

test("from a terminal Pi (no console attached) the gate is skipped instead of waiting 12 hours", async () => {
  const { db, run, cleanup } = setup();
  try {
    db.markStarted(run.id, "pi-run-1");
    assert.equal(gateRun(db, run.id, false), undefined, "a terminal Pi must not wait on the app's run");
    assert.equal(consoleAttached({}), false);
    assert.equal(consoleAttached({ ORCHESTRATORAI_CONSOLE: "1" }), true);
    assert.match(SKIPPED.content[0].text, /^DECISION: skipped/);
  } finally {
    cleanup();
  }
});

test("an empty or unknown run_id skips the gate rather than attaching to another running run", async () => {
  const { db, run, cleanup } = setup();
  try {
    db.markStarted(run.id, "pi-run-1"); // someone else's run, live
    assert.equal(gateRun(db, "", true), undefined);
    assert.equal(gateRun(db, "no-such-run", true), undefined);
    assert.equal(gateRun(db, run.id, true)?.id, run.id, "the app's own run, named by id, still waits");
    assert.equal(gateRun(db, "pi-run-1", true)?.id, run.id, "a pi-agents run id resolves to its local run");
  } finally {
    cleanup();
  }
});

// ---- Gate leftovers (2026-11-23): no app run behind a gate; timed-out status

test("a gate in a run journalled from a terminal is skipped, even with the console attached", async () => {
  const { db, cleanup } = setup();
  try {
    const tui = db.createRun({ id: "pi-tui-1", workflow: "contract-review", title: "TUI run", params: {}, origin: "tui" });
    db.markStarted(tui.id, tui.id);
    const app = db.createRun({ id: randomUUID(), workflow: "contract-review", title: "App run", params: {}, origin: "app" });
    db.markStarted(app.id, "pi-app-1");
    assert.equal(gateRun(db, tui.id, true), undefined, "nobody in the app answers a terminal run's gate");
    assert.equal(gateRun(db, app.id, true)?.id, app.id);
    assert.equal(gateRun(db, "pi-app-1", true)?.id, app.id);
    // Rows from before the origin column (null) keep waiting, as they did.
    const legacy = db.createRun({ id: randomUUID(), workflow: "contract-review", title: "Old run", params: {} });
    assert.equal(legacy.origin, null);
    assert.equal(gateRun(db, legacy.id, true)?.id, legacy.id);
  } finally {
    cleanup();
  }
});

test("no tool falls back to the newest running run when no run id is given", async () => {
  const { db, run, cleanup } = setup();
  try {
    db.markStarted(run.id, "pi-run-1"); // live, and the newest
    assert.equal(db.namedRun(""), undefined);
    assert.equal(db.namedRun("no-such-run"), undefined);
    assert.equal(db.namedRun(run.id)?.id, run.id);
    assert.equal(db.namedRun("pi-run-1")?.id, run.id);
    assert.equal((db as unknown as Record<string, unknown>).latestRunningRun, undefined, "the fallback is gone");
    assert.equal(gateRun(db, "", true), undefined);
  } finally {
    cleanup();
  }
});

test("a timed-out gate is stored as timed_out, journalled, and a new ask gets a fresh checkpoint", async () => {
  const { db, run, app, cleanup } = setup();
  try {
    const params = { title: "Approve the exhibit list", summary: "Exhibit list draft" };
    const result = await attorneyGate(db, run, params, undefined, { ...OPTS, maxWaitMs: 20 });
    assert.equal(result.details.status, "timed_out");
    const row = db.getCheckpoint(result.details.checkpointId as string)!;
    assert.equal(row.status, "timed_out");
    assert.equal(row.decision_comment, "No attorney decision was recorded in time.");
    assert.ok(row.decided_at);
    const events = app.prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY seq").all(run.id) as Array<{ type: string }>;
    assert.deepEqual(events.map((e) => e.type), ["gate_requested", "gate_timed_out"]);

    // Asking again is a new wait, not the timed-out row handed back.
    const again = attorneyGate(db, run, params, undefined, OPTS);
    assert.equal(await settle(again), "still waiting");
    const rows = app.prepare("SELECT status FROM checkpoints WHERE run_id = ? ORDER BY requested_at, rowid").all(run.id) as Array<{ status: string }>;
    assert.deepEqual(rows.map((r) => r.status), ["timed_out", "pending"]);
    decidePending(app, run.id, "approved", "ok");
    assert.match(text(await again), /^DECISION: approved/);
  } finally {
    cleanup();
  }
});
