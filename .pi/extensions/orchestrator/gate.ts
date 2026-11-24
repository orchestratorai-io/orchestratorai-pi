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

/** Set by the macOS app on the Pi it launches; delegated agents inherit it. */
export const CONSOLE_ENV = "ORCHESTRATORAI_CONSOLE";

export function consoleAttached(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CONSOLE_ENV] === "1";
}

export const SKIPPED: GateResult = {
  content: [{ type: "text", text: "DECISION: skipped\nCOMMENT: No OrchestratorAI console is attached to this run; continue without an attorney gate." }],
  details: { skipped: true },
};

/**
 * The run an attorney_review call should wait on, or undefined to skip the gate.
 * Only a run named by its id, and only when the app's console is attached: from a
 * terminal Pi (a TUI run, or `/orchestrator resume` typed by hand) nobody is
 * watching, and the gate used to sit there for GATE_MAX_WAIT_MS (12 hours). An
 * empty or unknown run_id no longer falls back to "the newest running run",
 * which could be someone else's run.
 */
export function gateRun(db: RunStore, runId: string, attached: boolean): RunRow | undefined {
  if (!attached || !runId) return undefined;
  const run = db.namedRun(runId);
  // A run journalled from a Pi terminal (or another extension) has no app run
  // behind it, even inside an app-launched Pi: nobody is shown its gate card.
  // Rows from before the origin column (null) keep waiting as they used to.
  if (!run || run.origin === "tui") return undefined;
  return run;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
  // Reuse an existing checkpoint only for the same question in the same step:
  // a pending one is waited on (also after a resume), and a decided one is
  // handed out again only to an agent that retries the tool before its step
  // finishes. A loop that asks under one title every turn (cross-exam) gets a
  // fresh attorney decision for every turn, including after a resume.
  const existing: CheckpointRow | undefined = db.findGateCheckpoint(run.id, params.title, params.summary);
  if (existing && existing.status !== "pending" && db.gateDecisionReusable(existing)) {
    const comment = existing.decision_comment?.trim() || "(no comment)";
    return {
      content: [{ type: "text", text: `DECISION: ${existing.status}\nCOMMENT: ${comment}` }],
      details: { checkpointId: existing.id, status: existing.status, reused: true },
    };
  }
  db.cancelGatesOrphanedByResume(run.id, params.title, params.summary);
  const checkpoint = existing && existing.status === "pending"
    ? existing
    : db.createCheckpoint({
        id: opts.newId(),
        runId: run.id,
        kind: "gate",
        title: params.title,
        summaryMarkdown: params.summary,
      });
  if (checkpoint !== existing) {
    db.appendEvent({ runId: run.id, type: "gate_requested", summary: `Waiting for attorney — ${params.title}`, detail: params.summary, payload: { checkpointId: checkpoint.id } });
  }

  const decided = (current: CheckpointRow): GateResult => {
    const comment = current.decision_comment?.trim() || "(no comment)";
    db.appendEvent({ runId: run.id, type: "gate_decided", summary: `Attorney ${current.status.replace("_", " ")} — ${params.title}`, detail: comment, payload: { checkpointId: checkpoint.id } });
    return {
      content: [{ type: "text", text: `DECISION: ${current.status}\nCOMMENT: ${comment}` }],
      details: { checkpointId: checkpoint.id, status: current.status },
    };
  };

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
    if (current && current.status !== "pending") return decided(current);
    if (Date.now() - startedAt > opts.maxWaitMs) {
      // Time out only this gate's checkpoint. Other agents in the run may be
      // waiting on their own approvals, and those stay pending and decidable.
      if (!db.timeOutCheckpointIfPending(checkpoint.id, "No attorney decision was recorded in time.")) {
        // The attorney decided between the last poll and the timeout: use it.
        const late = db.getCheckpoint(checkpoint.id);
        if (late && (late.status === "approved" || late.status === "changes_requested")) return decided(late);
      }
      db.appendEvent({ runId: run.id, type: "gate_timed_out", summary: `Attorney gate timed out — ${params.title}`, payload: { checkpointId: checkpoint.id } });
      return {
        content: [{ type: "text", text: "DECISION: timed_out\nCOMMENT: No attorney decision was recorded in time." }],
        details: { checkpointId: checkpoint.id, status: "timed_out" },
      };
    }
    await sleep(opts.pollMs, signal);
  }
}
