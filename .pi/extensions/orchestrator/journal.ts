/**
 * The run journal and the start/resume commands, kept apart from index.ts so
 * they can be tested without Pi (see test/journal.test.ts). index.ts wires
 * them to Pi's event bus and the `/orchestrator` command.
 *
 * Every pi-agents run event is written to the on-device store against the
 * local run row the app knows. A row is "owned" by the Pi process driving it
 * (`owner_pid`), which refreshes `heartbeat_at` while it lives, so the app and
 * a second Pi can tell a run that is waiting (on an attorney, on a slow model)
 * from one whose Pi is gone.
 */

import { randomUUID } from "node:crypto";
import type { RunRow, RunStore } from "./store.ts";

/** How often the owning Pi refreshes `heartbeat_at` for the runs it drives. */
export const HEARTBEAT_MS = 30_000;
/** A live owner pid whose heartbeat is older than this is treated as a reused pid, not a live run. */
export const HEARTBEAT_STALE_MS = 10 * 60_000;
/** Rows from before `owner_pid` existed: live if journalled to within this long. */
export const LEGACY_STALE_MS = 180_000;

// pi-agents run-event shapes we care about (see pi-agents/src/run/events.ts).
export type RunHeader = {
  id: string;
  label?: string;
  display?: string;
  source: { kind: string; workflow?: string; caller?: string };
  params?: Record<string, unknown>;
  /** Expanded flow; a saved-workflow start is a root `workflow` node carrying the params. */
  flow?: { kind?: string; name?: string; params?: Record<string, unknown> };
};
export type TraceEvent = {
  type: string;
  at?: number;
  runId?: string;
  run?: RunHeader;
  path?: string;
  instance?: string;
  kind?: string;
  profile?: string;
  label?: string;
  model?: string;
  sessionFile?: string;
  value?: unknown;
  error?: string;
  status?: string;
  reason?: string;
  iteration?: number;
  agents?: number;
  message?: string;
};

// ---------------------------------------------------------------- helpers

// Only node_started carries profile/label; remember them per node instance so
// later lifecycle events for the same node read the same way.
const nodeNames = new Map<string, string>();

function readableNode(event: TraceEvent): string {
  const key = `${event.runId ?? ""}:${event.instance ?? event.path ?? ""}`;
  const own = event.label ?? event.profile;
  if (own) {
    nodeNames.set(key, own);
    return own;
  }
  return nodeNames.get(key) ?? event.kind ?? "node";
}

function summarize(event: TraceEvent): string {
  switch (event.type) {
    case "run_created": {
      const workflow = event.run?.source?.workflow ?? "workflow";
      return `Started ${workflow}${event.run?.label ? ` — ${event.run.label}` : ""}`;
    }
    case "node_started":
      return `Started ${readableNode(event)}`;
    case "node_completed":
      return `Completed ${readableNode(event)}`;
    case "node_failed":
      return `Failed ${readableNode(event)}${event.error ? ` — ${event.error}` : ""}`;
    case "node_cancelled":
      return `Cancelled ${readableNode(event)}${event.reason ? ` (${event.reason})` : ""}`;
    case "node_steered":
      return `Steered ${readableNode(event)}`;
    case "node_model":
      return `Model ${event.model ?? ""} for ${readableNode(event)}`.trim();
    case "node_session":
      return `Session opened for ${readableNode(event)}`;
    case "loop_iteration":
      return `Iteration ${event.iteration ?? ""}`.trim();
    case "run_backgrounded":
      return "Workflow running in background";
    case "run_completed":
      return event.status === "completed"
        ? `Workflow completed · ${event.agents ?? 0} agent calls`
        : `Workflow ${event.status ?? "finished"}${event.error ? ` — ${event.error}` : ""}`;
    default:
      return event.type;
  }
}

function resolvePath(value: unknown, dotPath: string | undefined): unknown {
  if (!dotPath) return undefined;
  let current: unknown = value;
  for (const part of dotPath.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Human-facing Markdown for a completed run, mirroring pi-agents' rules. */
function presentResult(value: unknown, display: string | undefined): string | undefined {
  const pinned = resolvePath(value, display);
  if (typeof pinned === "string") return pinned;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const report = (value as Record<string, unknown>).report;
    if (typeof report === "string") return report;
  }
  return undefined;
}

export function jsonText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function stringMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}
// ----------------------------------------------------------------- resume

/**
 * Top-level step index for a node path. A saved-workflow run's root is a
 * `workflow` node whose body is the sequence, so steps are `$.body.steps[i]`.
 * A resumed run is an inline sequence, so steps are `$.steps[k]` and map back
 * to the original index via the run's resume offset.
 */
function topLevelStepIndex(path: string | undefined, resumeOffset: number): number | undefined {
  if (!path) return undefined;
  let m = /^\$\.body\.steps\[(\d+)\]$/.exec(path);
  if (m) return Number(m[1]);
  m = /^\$\.steps\[(\d+)\]$/.exec(path);
  if (m) return Number(m[1]) + resumeOffset;
  return undefined;
}

/** pi-agents interpolates `{...}` in strings; stored values must be re-submitted literally. */
function escapeBraces(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\{/g, "{{").replace(/\}/g, "}}");
  if (Array.isArray(value)) return value.map(escapeBraces);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, escapeBraces(v)]));
  return value;
}

/** Inline flows carry no params, so `{params.x}` in the remaining steps is replaced with the literal value. */
function substituteParams(node: unknown, params: Record<string, string>): unknown {
  if (typeof node === "string") {
    return node.replace(/\{params\.([A-Za-z0-9_-]+)\}/g, (whole, name: string) =>
      name in params ? (escapeBraces(params[name]) as string) : whole,
    );
  }
  if (Array.isArray(node)) return node.map((n) => substituteParams(n, params));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      // Expansion-derived fields cannot be author-supplied; pi-agents re-expands workflow refs by name.
      if (k === "body" && (node as { kind?: string }).kind === "workflow") continue;
      if (k === "paramDefs") continue;
      out[k] = substituteParams(v, params);
    }
    return out;
  }
  return node;
}

/**
 * Build the flow that finishes an interrupted run: `value` nodes re-bind every
 * completed top-level step's result (an attorney override wins over the stored
 * value), then the remaining steps run unchanged. A step that was partly done
 * (a loop mid-iteration, a gate mid-wait) re-runs whole; gates are idempotent.
 */
export function buildResumeFlow(run: RunRow, completed: Map<number, unknown>, overrides: Map<number, unknown>) {
  if (!run.flow_json) throw new Error("run has no stored flow (started before resume support)");
  const flow = JSON.parse(run.flow_json) as { kind: string; body?: { kind: string; steps?: unknown[] }; steps?: unknown[] };
  const root = flow.kind === "workflow" ? flow.body : flow;
  if (!root || root.kind !== "sequence" || !Array.isArray(root.steps)) throw new Error("resume supports sequence-rooted workflows");
  const steps = root.steps as Array<{ as?: string }>;
  let resumeAt = 0;
  while (resumeAt < steps.length && (overrides.has(resumeAt) || completed.has(resumeAt))) resumeAt++;
  if (resumeAt >= steps.length) throw new Error("nothing to resume: every step already completed");
  const params = JSON.parse(run.params_json) as Record<string, string>;
  const rebinds = [];
  for (let i = 0; i < resumeAt; i++) {
    const as = steps[i].as;
    if (!as) continue;
    const value = overrides.has(i) ? overrides.get(i) : completed.get(i);
    rebinds.push({ kind: "value", value: escapeBraces(value), as, label: `resume:${as}` });
  }
  const remaining = steps.slice(resumeAt).map((st) => substituteParams(st, params));
  // In the rebuilt flow, `$.steps[k]` is original step `k - rebinds.length + resumeAt`.
  const resumeOffset = resumeAt - rebinds.length;
  return { flow: { kind: "sequence", steps: [...rebinds, ...remaining] }, resumeAt, resumeOffset, display: run.display ?? undefined };
}
// ------------------------------------------------------------- liveness

/** Whether a process with this pid exists (EPERM: it exists but is not ours). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function ageMs(iso: string | null, now: number): number {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Infinity : now - t;
}

/**
 * Why this run must not be resumed now because a Pi is still driving it, or
 * undefined when nothing is. The row's status is not enough: a run can read
 * `stopped` while its Pi is still waiting at a gate.
 */
export function stillRunningReason(
  row: RunRow,
  ctx: { selfPid: number; ownedHere: boolean; now: number; pidAlive: (pid: number) => boolean },
): string | undefined {
  if (ctx.ownedHere) return "this run is already running in this Pi";
  if (row.owner_pid !== null && row.owner_pid !== undefined) {
    if (row.owner_pid === ctx.selfPid) return undefined; // claimed by this process earlier, since finished
    if (ctx.pidAlive(row.owner_pid) && ageMs(row.heartbeat_at, ctx.now) < HEARTBEAT_STALE_MS) {
      return `this run is still running in another Pi (process ${row.owner_pid}). Stop it there, or wait for it to finish, before resuming`;
    }
    return undefined;
  }
  if ((row.status === "queued" || row.status === "running") && ageMs(row.updated_at, ctx.now) < LEGACY_STALE_MS) {
    return "this run is still running (it was updated in the last 3 minutes). Stop it before resuming";
  }
  return undefined;
}

// --------------------------------------------------------------- journal

export interface AgentsApi {
  start(params: { workflow?: string; flow?: unknown; params?: Record<string, string>; label?: string; display?: string }): Promise<{ runId: string; warnings?: string[] }>;
}

export interface JournalOptions {
  pid?: number;
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
  /** How long resume waits for a previous Pi that is still exiting (the app stops it just before resuming). */
  ownerExitWaitMs?: number;
}

export type Reply = Record<string, unknown> & { ok: boolean; op: string };

export class Journal {
  private readonly headers = new Map<string, RunHeader>();
  private readonly piToLocal = new Map<string, string>();
  /** Set while a resume's `start` is in flight, so its `run_created` lands on the run being resumed. */
  private pendingResume: { runId: string; label: string; resumeOffset: number; attachedTo?: string } | undefined;
  readonly pid: number;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly store: () => RunStore | undefined;
  private readonly agents: AgentsApi;
  private readonly ownerExitWaitMs: number;

  constructor(store: () => RunStore | undefined, agents: AgentsApi, opts: JournalOptions = {}) {
    this.store = store;
    this.agents = agents;
    this.pid = opts.pid ?? process.pid;
    this.pidAlive = opts.pidAlive ?? processAlive;
    this.now = opts.now ?? Date.now;
    this.ownerExitWaitMs = opts.ownerExitWaitMs ?? 5_000;
  }

  /** Local run ids this Pi is driving right now. */
  liveRunIds(): string[] {
    return [...new Set(this.piToLocal.values())];
  }

  heartbeat(): void {
    const ids = this.liveRunIds();
    if (ids.length) this.store()?.heartbeat(ids, this.pid);
  }

  /** Pi is shutting down: nothing drives its runs any more. */
  release(): void {
    this.store()?.releaseOwnedRuns(this.pid);
  }

  // Resolve (or lazily create) the local run row for a pi-agents run id.
  private localRunFor(event: TraceEvent, db: RunStore): RunRow | undefined {
    const piRunId = event.type === "run_created" ? event.run?.id : event.runId;
    if (!piRunId) return undefined;
    const cached = this.piToLocal.get(piRunId);
    if (cached) return db.getRun(cached);

    let row = db.findRunByPiId(piRunId);
    if (!row && event.type === "run_created" && event.run) {
      // pi-agents emits run_created inside `start`, before its reply. For a resume
      // that is the resumed run; an inline resume flow carries no run_id param, so
      // without this it used to get a junk "inline … (resumed)" row of its own.
      const pending = this.pendingResume;
      if (pending && !pending.attachedTo && event.run.label === pending.label) {
        pending.attachedTo = piRunId;
        db.markResumed(pending.runId, piRunId, pending.resumeOffset, this.pid);
        this.piToLocal.set(piRunId, pending.runId);
        return db.getRun(pending.runId);
      }
      const declared = event.run.params?.run_id ?? event.run.flow?.params?.run_id;
      if (typeof declared === "string" && declared) row = db.getRun(declared);
      if (!row) {
        // A run started from the TUI (or another extension): journal it too.
        row = db.createRun({
          id: piRunId,
          workflow: event.run.source.workflow ?? event.run.flow?.name ?? "inline",
          title: event.run.label ?? event.run.source.workflow ?? "Workflow run",
          params: stringMap(event.run.params ?? event.run.flow?.params),
          ownerPid: this.pid,
        });
      }
      db.markStarted(row.id, piRunId, this.pid);
      row = db.getRun(row.id);
    }
    if (row) this.piToLocal.set(piRunId, row.id);
    return row;
  }

  onRunEvent(raw: unknown): void {
    const event = raw as TraceEvent;
    const db = this.store();
    if (!db || typeof event?.type !== "string") return;

    if (event.type === "run_created" && event.run) this.headers.set(event.run.id, event.run);
    const run = this.localRunFor(event, db);
    if (!run) return;
    if (event.type === "run_created" && event.run) {
      // Keep the expanded flow: resume rebuilds the remainder of it from stored step values.
      if (run.resumes === 0) db.setFlow(run.id, event.run.flow, event.run.display);
    }

    const detail =
      event.type === "node_completed"
        ? (typeof event.value === "string" ? event.value : jsonText(event.value))
        : event.type === "node_failed"
          ? event.error
          : undefined;

    const summary = summarize(event); // also remembers node_started's label for later events of that node
    const label = event.label ?? nodeNames.get(`${event.runId ?? ""}:${event.instance ?? event.path ?? ""}`);
    // A resume's `resume:*` value nodes only re-bind steps that already have their
    // completion (or an attorney override) journalled. Recording them as step
    // completions again would file them under a wrong step number whenever an
    // earlier step has no `as`, and would turn an override into the stored value.
    const rebind = typeof label === "string" && label.startsWith("resume:");
    db.appendEvent({
      runId: run.id,
      type: event.type,
      at: event.at,
      summary,
      nodePath: event.path,
      nodeInstance: event.instance,
      nodeKind: event.kind,
      agent: event.profile,
      label,
      detail: detail ?? (event.type === "node_session" ? event.sessionFile : undefined),
      value: event.type === "node_completed" ? event.value : undefined,
      stepIndex: event.type === "node_completed" && !rebind ? topLevelStepIndex(event.path, run.resume_offset) : undefined,
    });

    if (event.type === "run_completed") {
      const header = this.headers.get(event.runId ?? "");
      const status = (event.status ?? "failed") as "completed" | "failed" | "stopped";
      const markdown = presentResult(event.value, header?.display);
      db.markFinished(run.id, {
        status,
        error: event.error,
        resultMarkdown: markdown,
        resultJson: jsonText(event.value),
        agents: event.agents,
        at: event.at,
      });
      if (status === "completed") {
        db.createCheckpoint({
          id: randomUUID(),
          runId: run.id,
          kind: "final_review",
          title: "Attorney review of final report",
          summaryMarkdown: markdown,
        });
      } else {
        db.cancelPendingCheckpoints(run.id, `Workflow ${status}.`);
      }
      this.headers.delete(event.runId ?? "");
      if (event.runId) this.piToLocal.delete(event.runId);
    }
  }

  async start(db: RunStore, input: Record<string, unknown>, fallbackModel: string | undefined): Promise<Reply> {
    const workflow = typeof input.workflow === "string" ? input.workflow : "";
    if (!workflow) throw new Error("'workflow' is required");
    const runId = typeof input.runId === "string" && input.runId ? input.runId : randomUUID();
    const title = typeof input.title === "string" && input.title ? input.title : workflow;
    const params = { ...stringMap(input.params), run_id: runId };
    const row = db.createRun({
      id: runId,
      workflow,
      title,
      sourceDocument: typeof input.sourceDocument === "string" ? input.sourceDocument : undefined,
      params,
      model: typeof input.model === "string" ? input.model : fallbackModel,
      ownerPid: this.pid,
    });
    db.appendEvent({ runId: row.id, type: "queued", summary: `Queued ${workflow}` });
    try {
      const started = await this.agents.start({ workflow, params, label: title });
      db.markStarted(row.id, started.runId, this.pid);
      this.piToLocal.set(started.runId, row.id);
      return { ok: true, op: "start", runId: row.id, piRunId: started.runId, warnings: started.warnings ?? [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.appendEvent({ runId: row.id, type: "start_failed", summary: `Could not start — ${message}` });
      db.markFinished(row.id, { status: "failed", error: message });
      return { ok: false, op: "start", runId: row.id, error: message };
    }
  }

  async resume(db: RunStore, input: Record<string, unknown>): Promise<Reply> {
    const runId = typeof input.runId === "string" ? input.runId : "";
    const row = db.getRun(runId);
    if (!row) throw new Error(`unknown run '${runId}'`);
    if (row.status === "completed") throw new Error("run already completed");
    const ownedHere = this.liveRunIds().includes(row.id) || this.pendingResume?.runId === row.id;
    const busyNow = () =>
      stillRunningReason(db.getRun(row.id) ?? row, { selfPid: this.pid, ownedHere, now: this.now(), pidAlive: this.pidAlive });
    let busy = busyNow();
    // The app stops the old Pi right before it resumes; give that process a moment to exit.
    for (const deadline = Date.now() + this.ownerExitWaitMs; busy && !ownedHere && Date.now() < deadline; busy = busyNow()) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (busy) throw new Error(`not resumed: ${busy}.`);
    const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
    const { flow, resumeAt, resumeOffset, display } = buildResumeFlow(row, db.completedStepValues(row.id), db.stepOverrides(row.id));
    const nth = row.resumes + 1;
    const suffix = nth % 100 >= 11 && nth % 100 <= 13 ? "th" : nth % 10 === 1 ? "st" : nth % 10 === 2 ? "nd" : nth % 10 === 3 ? "rd" : "th";
    db.appendEvent({ runId: row.id, type: "resume", summary: `Resuming from step ${resumeAt + 1} (${nth}${suffix} resume${model ? ` on ${model}` : ""})` });
    const label = `${row.title} (resumed)`;
    this.pendingResume = { runId: row.id, label, resumeOffset };
    try {
      const started = await this.agents.start({ flow, label, display });
      // run_created normally arrives inside `start` and has already claimed the row.
      if (this.pendingResume.attachedTo !== started.runId) db.markResumed(row.id, started.runId, resumeOffset, this.pid);
      this.piToLocal.set(started.runId, row.id);
      if (model) db.setModel(row.id, model);
      return { ok: true, op: "resume", runId: row.id, piRunId: started.runId, resumeAt, model: model ?? row.model, warnings: started.warnings ?? [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.appendEvent({ runId: row.id, type: "start_failed", summary: `Could not resume — ${message}` });
      return { ok: false, op: "resume", runId: row.id, error: message };
    } finally {
      this.pendingResume = undefined;
    }
  }
}
