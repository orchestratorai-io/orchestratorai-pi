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
import { attorneyGate, type GateResult } from "../gate.ts";

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
