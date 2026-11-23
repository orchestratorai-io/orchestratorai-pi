/**
 * The attorney_review gate: pause a workflow step until the attorney decides
 * in the app. Kept apart from index.ts so it can be tested without Pi
 * (see test/gate.test.ts).
 */

import type { CheckpointRow, RunRow, RunStore } from "./store.ts";

export interface GateParams {
  title: string;
  summary: string;
}

export interface GateOptions {
  pollMs: number;
  maxWaitMs: number;
  newId: () => string;
}

export interface GateResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function attorneyGate(
  db: RunStore,
  run: RunRow,
  params: GateParams,
  signal: AbortSignal | undefined,
  opts: GateOptions,
): Promise<GateResult> {
  // Idempotent per (run, title): a delegated agent that calls this tool
  // twice for the same decision reuses the existing checkpoint instead of
  // asking the attorney the same question again.
  const existing: CheckpointRow | undefined = db.findCheckpointByTitle(run.id, params.title);
  if (existing && existing.status !== "pending" && existing.status !== "cancelled") {
    const comment = existing.decision_comment?.trim() || "(no comment)";
    return {
      content: [{ type: "text", text: `DECISION: ${existing.status}\nCOMMENT: ${comment}` }],
      details: { checkpointId: existing.id, status: existing.status, reused: true },
    };
  }
  const checkpoint = existing && existing.status === "pending"
    ? existing
    : db.createCheckpoint({
        id: opts.newId(),
        runId: run.id,
        kind: "gate",
        title: params.title,
        summaryMarkdown: params.summary,
      });
  if (!existing || existing.status !== "pending") {
    db.appendEvent({ runId: run.id, type: "gate_requested", summary: `Waiting for attorney — ${params.title}`, detail: params.summary });
  }

  const startedAt = Date.now();
  while (true) {
    if (signal?.aborted) {
      // The agent is going away (Pi killed, run stopped) but the attorney has not decided.
      // Leave the checkpoint pending: a resumed gate step finds it and waits on the same row.
      // An explicit /orchestrator stop cancels pending checkpoints itself.
      db.appendEvent({ runId: run.id, type: "gate_interrupted", summary: `Gate interrupted, still awaiting attorney — ${params.title}` });
      throw new Error("attorney_review interrupted");
    }
    const current = db.getCheckpoint(checkpoint.id);
    if (current && current.status !== "pending") {
      const comment = current.decision_comment?.trim() || "(no comment)";
      db.appendEvent({ runId: run.id, type: "gate_decided", summary: `Attorney ${current.status.replace("_", " ")} — ${params.title}`, detail: comment });
      return {
        content: [{ type: "text", text: `DECISION: ${current.status}\nCOMMENT: ${comment}` }],
        details: { checkpointId: checkpoint.id, status: current.status },
      };
    }
    if (Date.now() - startedAt > opts.maxWaitMs) {
      db.cancelPendingCheckpoints(run.id, "Timed out waiting for an attorney decision.");
      return {
        content: [{ type: "text", text: "DECISION: timed_out\nCOMMENT: No attorney decision was recorded in time." }],
        details: { checkpointId: checkpoint.id, status: "timed_out" },
      };
    }
    await sleep(opts.pollMs, signal);
  }
}
