/**
 * OrchestratorAI bridge for Pi.
 *
 * Five responsibilities, all deterministic (no chat model in the loop):
 *
 * 1. `/orchestrator start|stop|ping <json>` — a slash command the macOS app
 *    invokes over Pi RPC. `start` launches a saved pi-agents workflow by name
 *    with literal params. The root model never decides whether to run it.
 *
 * 2. Run journal — every pi-agents run event (workflow tree, node lifecycle,
 *    intermediate values, final result) is written to the on-device SQLite
 *    store at data/orchestrator.sqlite. The app reads that file; nothing is
 *    smuggled through the RPC UI channel.
 *
 * 3. `attorney_review` tool — a human-in-the-loop gate that a workflow agent
 *    can call mid-flow. It records a pending checkpoint and blocks until the
 *    attorney approves or requests changes in the app. Delegated agents run
 *    in this same project, so they load this extension and see the tool.
 *
 * 4. `jev_check` tool — runs a named rubric from `.pi/rubrics/` against text
 *    and returns a routed decision (pass | review | block) with calibrated
 *    answers. The rubric's questions go to a decision model (Clef on the Mac
 *    Studio's Ollama by default) through the vendored `./decisions` client.
 *    Every evaluation is recorded in the store. The tool keeps its historical
 *    name because workflows and stored runs reference it.
 *
 * 5. `report_guard` tool — runs a rubric over a finished step of the run as a
 *    quality guard (citations in the record, checklist severity, privilege in
 *    the production set, missed alerts, coaching). It reads the step output
 *    from the journal and the record from disk, so no chat model copies the
 *    text. The splitting and combining is code in ./guards.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { RunStore, RunRow } from "./store";
import { Journal } from "./journal.ts";
import { ExtensionRuntime } from "./runtime.ts";
import { DecisionClient, runRubric, type Rubric } from "./decisions/index.ts";
import { guardBlock, validateSpec, runGuards, type GuardContext, type GuardSpec } from "./guards.ts";
import { attorneyGate, consoleAttached, gateRun, sleep, SKIPPED } from "./gate.ts";
import { ollamaThinkingPayload } from "./ollama-thinking.ts";
import { registerRequiredSource } from "./require-source.ts";

const CALLER = "orchestratorai";
const REPLY_TYPE = "orchestrator:reply";
const GATE_POLL_MS = 1500;
const GATE_MAX_WAIT_MS = 12 * 60 * 60 * 1000;

// ---------------------------------------------------------------- helpers

function findProjectDir(start: string): string {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, ".pi", "settings.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

function parseJsonArg(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

// Raw pi-agents event-bus client. The documented channels need no import from
// the pi-agents package, which keeps this extension independent of where Pi
// installed that package.
const RUN_EVENT_CHANNEL = "pi-agents:run-event";
const RPC_REQUEST_CHANNEL = "pi-agents:rpc:request";
const RPC_REPLY_PREFIX = "pi-agents:rpc:reply:";
// pi-agents 0.21 speaks envelope protocol 2 (see pi-agents/src/protocol.ts).
const PI_AGENTS_PROTOCOL = 2;

function piAgentsBus(pi: any) {
  function request<T = any>(op: string, params?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`pi-agents '${op}' timed out — is the pi-agents package loaded?`));
      }, 15000);
      const unsubscribe = pi.events.on(`${RPC_REPLY_PREFIX}${id}`, (raw: any) => {
        clearTimeout(timer);
        unsubscribe();
        if (raw?.success) resolve(raw.data as T);
        else reject(new Error(raw?.error ?? `pi-agents '${op}' failed`));
      });
      pi.events.emit(RPC_REQUEST_CHANNEL, { protocol: PI_AGENTS_PROTOCOL, id, caller: CALLER, op, params });
    });
  }
  return {
    start: (params: { workflow?: string; flow?: unknown; params?: Record<string, string>; label?: string; display?: string }) =>
      request<{ runId: string; warnings?: string[] }>("start", params),
    stop: (runId: string) => request("stop", { runId }),
    onRunEvent: (handler: (event: unknown) => void) =>
      pi.events.on(RUN_EVENT_CHANNEL, (envelope: any) => {
        if (envelope?.event) handler(envelope.event);
      }),
  };
}

// -------------------------------------------------------------- extension

export default function orchestrator(pi: any) {
  const agents = piAgentsBus(pi);
  // The store link and the heartbeat timer are per process, not per copy of this
  // extension: a reload or session switch loads a new copy while runs go on (runtime.ts).
  let runtime: ExtensionRuntime | undefined;
  const journal = new Journal(() => runtime?.store, agents);
  runtime = new ExtensionRuntime(journal);
  const rt = runtime;

  pi.on("before_provider_request", ({ payload }: { payload: unknown }, ctx: any) =>
    ollamaThinkingPayload(payload, ctx.model, pi.getThinkingLevel()));
  if (process.env.PI_AGENTS_DEPTH) registerRequiredSource(pi);

  function openStore(cwd: string): RunStore {
    return rt.ensureStore(findProjectDir(cwd));
  }

  function reply(payload: Record<string, unknown>) {
    pi.sendMessage(
      { customType: REPLY_TYPE, content: JSON.stringify(payload), display: true },
      { triggerTurn: false },
    );
  }

  pi.on("session_start", (_event: unknown, ctx: any) => {
    rt.sessionStore(findProjectDir(ctx.cwd));
    if (ctx?.hasUI) ctx.ui.setStatus("orchestratorai", "OrchestratorAI journal active");
  });

  // ------------------------------------------------ live text (child side)
  // Delegated agents run this same extension. Each one streams what it is
  // writing into run_progress keyed by its session file; the parent journals
  // that file in the node_session event, so the app can join the two. Every
  // stream event carries `partial` (the assistant message so far), and the
  // deliverable arrives as the arguments of the pi_agents_submit_result tool
  // call, not as text - so both are rendered. Throttled to ~4 writes/s.
  let liveSessionFile: string | undefined;
  let livePending: string | undefined;
  let liveFlushTimer: ReturnType<typeof setTimeout> | undefined;

  function renderPartial(message: any): string {
    const parts: string[] = [];
    for (const c of message?.content ?? []) {
      if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
      else if (c?.type === "toolCall") {
        const args = c.arguments ?? {};
        if (c.name === "pi_agents_submit_result") {
          const result = args.result ?? args.error;
          parts.push(typeof result === "string" ? result : JSON.stringify(result ?? args, null, 2));
        } else {
          parts.push(`[${c.name}] ${JSON.stringify(args).slice(0, 200)}`);
        }
      }
    }
    return parts.join("\n\n");
  }
  function flushLive() {
    liveFlushTimer = undefined;
    const store = rt.store;
    if (store && liveSessionFile && livePending !== undefined) store.setProgress(liveSessionFile, livePending);
  }
  pi.on("agent_start", (_e: unknown, ctx: any) => {
    liveSessionFile = ctx?.sessionManager?.getSessionFile?.();
  });
  pi.on("message_update", (event: any, ctx: any) => {
    const ev = event?.assistantMessageEvent;
    if (!ev || !/_delta$/.test(String(ev.type))) return;
    if (!liveSessionFile) liveSessionFile = ctx?.sessionManager?.getSessionFile?.();
    livePending = renderPartial(ev.partial ?? event.message);
    if (!liveFlushTimer) liveFlushTimer = setTimeout(flushLive, 250);
  });
  pi.on("agent_settled", () => {
    if (liveFlushTimer) { clearTimeout(liveFlushTimer); flushLive(); }
  });

  pi.on("session_shutdown", (event: any) => {
    if (liveFlushTimer) { clearTimeout(liveFlushTimer); flushLive(); }
    if (liveSessionFile) rt.store?.clearProgress(liveSessionFile);
    // Pi 0.85 reasons: "quit" ends the process; "reload", "new", "resume" and "fork" only
    // replace this copy of the extension while pi-agents runs go on, so those keep the
    // store and heartbeat for the next copy, which re-adopts this process's runs.
    rt.shutdown(event?.reason);
  });

  // --------------------------------------------------- run event journal

  agents.onRunEvent((raw: unknown) => journal.onRunEvent(raw));

  // ------------------------------------------------------- app command

  pi.registerCommand("orchestrator", {
    description:
      "OrchestratorAI control: start|stop|ping <json>. Used by the macOS app over RPC.",
    handler: async (args: string, ctx: any) => {
      const db = openStore(ctx.cwd);
      const [sub, ...rest] = args.trim().split(/\s+/);
      const rawJson = rest.join(" ");
      try {
        switch (sub) {
          case "ping": {
            reply({ ok: true, op: "ping", store: db.path, projectDir: rt.projectDir });
            return;
          }
          case "start": {
            reply(await journal.start(db, parseJsonArg(rawJson), ctx.model?.id));
            return;
          }
          case "resume": {
            reply(await journal.resume(db, parseJsonArg(rawJson)));
            return;
          }
          case "stop": {
            const input = parseJsonArg(rawJson);
            const runId = typeof input.runId === "string" ? input.runId : "";
            const row = db.getRun(runId);
            if (!row?.pi_run_id) throw new Error(`no live run '${runId}'`);
            await agents.stop(row.pi_run_id);
            db.cancelPendingCheckpoints(row.id, "Stopped by the user.");
            reply({ ok: true, op: "stop", runId });
            return;
          }
          default:
            throw new Error("usage: /orchestrator start|resume|stop|ping <json>");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply({ ok: false, op: sub ?? "", error: message });
      }
    },
  });

  // --------------------------------------------------------- HITL gate

  pi.registerTool({
    name: "attorney_review",
    label: "Attorney review",
    description:
      "Pause this workflow until a supervising attorney records a decision in the " +
      "OrchestratorAI console. Call it only when your task explicitly instructs you " +
      "to request an attorney decision. Returns the decision (approved or " +
      "changes_requested) and any attorney comment.",
    parameters: Type.Object({
      run_id: Type.String({
        description: "The OrchestratorAI run id given in your task. Pass an empty string if none was given.",
      }),
      title: Type.String({ description: "Short title of what the attorney is deciding." }),
      summary: Type.String({ description: "Markdown the attorney should read before deciding." }),
    }),
    async execute(_id: string, params: { run_id: string; title: string; summary: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      const db = openStore(ctx.cwd);
      const attached = consoleAttached();
      const run = gateRun(db, params.run_id, attached);
      if (!run) {
        const named = db.namedRun(params.run_id);
        if (named) db.appendEvent({ runId: named.id, type: "gate_skipped", summary: `Gate skipped, no console attached — ${params.title}` });
        return SKIPPED;
      }

      return attorneyGate(db, run, params, signal, { pollMs: GATE_POLL_MS, maxWaitMs: GATE_MAX_WAIT_MS, newId: randomUUID });
    },
  });

  // ------------------------------------------------- decision rubrics

  let decisionClient: DecisionClient | undefined;
  let rubricCache: Map<string, Rubric> | undefined;
  async function decisions(cwd: string): Promise<{ client: DecisionClient; rubrics: Map<string, Rubric> }> {
    if (!rubricCache) {
      // Loaded on first use: it needs `yaml` (npm install here), and its absence must not stop the extension loading.
      const { loadRubricDir } = await import("./decisions/node.ts");
      rubricCache = loadRubricDir(process.env.DECISION_RUBRIC_DIR || path.join(findProjectDir(cwd), ".pi", "rubrics"));
    }
    if (!decisionClient) decisionClient = new DecisionClient(); // throws a clear error if DECISION_BASE_URL is unset
    return { client: decisionClient, rubrics: rubricCache };
  }

  pi.registerTool({
    name: "jev_check",
    label: "Rubric check",
    description:
      "Run a named OrchestratorAI rubric (typed questions answered by a calibrated decision model, not a chat LLM) against text and get " +
      "a routed decision: pass (safe to use), review (a human should look), or block (do not use this " +
      "content). Rubrics: witness-coaching (does witness-prep text script or re-frame testimony?), " +
      "citation-in-record (is a claim supported by the record? inputs claim+record), severity-normalize " +
      "(HIGH/MEDIUM/LOW for one finding), privilege-coding, signal-classify. Call it only when your task " +
      "tells you to.",
    parameters: Type.Object({
      rubric: Type.String({ description: "Rubric name, e.g. witness-coaching" }),
      inputs: Type.Union([Type.String(), Type.Record(Type.String(), Type.Any())], {
        description: "The text for single-input rubrics, or an object of the rubric's named inputs.",
      }),
      run_id: Type.String({ description: "The OrchestratorAI run id given in your task; empty if none." }),
    }),
    async execute(_id: string, params: { rubric: string; inputs: string | Record<string, unknown>; run_id: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      const db = openStore(ctx.cwd);
      const { client, rubrics } = await decisions(ctx.cwd);
      const rubric = rubrics.get(params.rubric);
      if (!rubric) throw new Error(`unknown rubric '${params.rubric}'. Available: ${[...rubrics.keys()].join(", ")}`);
      const result = await runRubric(client, rubric, params.inputs);
      const run = db.namedRun(params.run_id);
      const preview = typeof params.inputs === "string" ? params.inputs : JSON.stringify(params.inputs);
      db.recordEvaluation({
        id: randomUUID(), runId: run?.id, rubric: result.rubric, rubricVersion: result.version,
        decision: result.decision, reason: result.reason, answers: result.answers,
        statePreview: preview.slice(0, 400), model: result.model,
        inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens,
      });
      if (run) db.appendEvent({ runId: run.id, type: "jev_check", summary: `Rubric ${result.rubric} → ${result.decision} (${result.reason})`, detail: JSON.stringify(result.answers, null, 2) });
      return {
        content: [{ type: "text", text: JSON.stringify({ decision: result.decision, reason: result.reason, answers: result.answers }, null, 2) }],
        details: { rubric: result.rubric, version: result.version, decision: result.decision },
      };
    },
  });

  // ------------------------------------------------------ report guards

  // The guard reads the step's output from the run journal and its configuration from the
  // workflow's own ```orchestrator-guards block, so the agent that calls it passes one
  // argument and never copies a report into a tool call (where a local model shortens or
  // edits it). The splitting and combining is code in ./guards.ts.
  pi.registerTool({
    name: "report_guard",
    label: "Quality guards",
    description:
      "Run this workflow's calibrated quality guards over its finished report and get back a Markdown " +
      "'## Quality guards' section: whether every dated, numbered or quoted statement is in the record, " +
      "whether checklist severities are right, and (per workflow) privilege, missed alerts or witness " +
      "coaching. Each decision is pass, review or block. The tool reads the report, the record and the " +
      "guard settings itself. Call it only when your task tells you to.",
    parameters: Type.Object({
      run_id: Type.String({ description: "The OrchestratorAI run id given in your task; empty if none." }),
    }),
    async execute(_id: string, params: { run_id: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      const db = openStore(ctx.cwd);
      const projectDir = findProjectDir(ctx.cwd);
      const run = (params.run_id && (db.getRun(params.run_id) ?? db.findRunByPiId(params.run_id))) || db.latestRunningRun();
      const reply = (decision: string, markdown: string) => {
        if (run) db.appendEvent({ runId: run.id, type: "report_guard", summary: `Quality guards → ${decision}`, detail: markdown });
        return { content: [{ type: "text", text: markdown }], details: { decision } };
      };
      const fallback = (why: string) =>
        reply("review", `## Quality guards\n\n- **Quality guards: Review.** ${why} A person must check this report.`);
      if (!run) return fallback("No OrchestratorAI run was found, so the guards could not read the report.");

      let spec: GuardSpec;
      try {
        const file = path.join(projectDir, ".pi", "workflows", `${run.workflow}.yaml`);
        const block = guardBlock(fs.readFileSync(file, "utf8"));
        if (!block) return fallback(`Workflow '${run.workflow}' declares no guards.`);
        const YAML = (await import("yaml")).default;
        spec = validateSpec(YAML.parse(block));
      } catch (e) {
        return fallback(`The guard settings could not be read (${(e as Error).message}).`);
      }

      // The parent Pi process journals the step's completion; give it a moment to land.
      let report: string | undefined;
      for (let i = 0; i < 20 && report === undefined; i++) {
        report = db.latestStepOutput(run.id, spec.step);
        if (report === undefined) await sleep(1000, signal);
      }
      if (report === undefined) return fallback(`The output of step '${spec.step}' was not found in the run journal.`);

      let guardCtx: GuardContext;
      try {
        const { client, rubrics } = await decisions(ctx.cwd);
        guardCtx = {
          client, rubrics,
          onItem: (rubric, item, preview) => db.recordEvaluation({
            id: randomUUID(), runId: run.id, rubric: rubric.name, rubricVersion: rubric.version,
            decision: item.decision, reason: item.error ? `${item.reason}: ${item.error}` : item.reason,
            answers: item.result?.answers ?? {}, statePreview: preview.slice(0, 400), model: item.result?.model,
            inputTokens: item.result?.usage?.input_tokens, outputTokens: item.result?.usage?.output_tokens,
          }),
        };
      } catch (e) {
        return fallback(`The decision model is not available (${(e as Error).message}).`);
      }
      let runParams: Record<string, unknown> = {};
      try { runParams = JSON.parse(run.params_json) as Record<string, unknown>; } catch { /* none */ }
      const out = await runGuards(guardCtx, spec, {
        report, params: runParams, projectDir,
        stepOutput: (label) => db.latestStepOutput(run.id, label),
      });
      return reply(out.decision, out.markdown);
    },
  });

  // ------------------------------------------------------ typed run state

  function resolveRun(db: RunStore, runId: string): RunRow {
    const run = db.namedRun(runId);
    if (!run) throw new Error(runId ? `no run '${runId}' to attach state to` : "no run to attach state to (pass the run_id from your task)");
    return run;
  }

  pi.registerTool({
    name: "state_update",
    label: "Update run state",
    description:
      "Write to this run's typed state in the store. Reducers are enforced by the store, not by you: " +
      "'set' replaces, 'append' pushes onto an array, 'merge' overlays object keys. Use it to accumulate " +
      "results across loop iterations (e.g. append this round's record) instead of carrying the whole " +
      "history in your own output. Returns the new value and version.",
    parameters: Type.Object({
      run_id: Type.String({ description: "The OrchestratorAI run id given in your task; empty if none." }),
      key: Type.String({ description: "State key, e.g. rounds" }),
      reducer: Type.Union([Type.Literal("set"), Type.Literal("append"), Type.Literal("merge")]),
      value: Type.Any({ description: "The value to set, the item(s) to append, or the object to merge." }),
    }),
    async execute(_id: string, params: { run_id: string; key: string; reducer: "set" | "append" | "merge"; value: unknown }, _s: AbortSignal | undefined, _u: unknown, ctx: any) {
      const db = openStore(ctx.cwd);
      const run = resolveRun(db, params.run_id);
      const result = db.updateState(run.id, params.key, params.reducer, params.value);
      db.appendEvent({ runId: run.id, type: "state", summary: `state ${params.reducer} ${params.key} → v${result.version}` });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { key: params.key, version: result.version } };
    },
  });

  pi.registerTool({
    name: "state_get",
    label: "Read run state",
    description: "Read this run's typed state from the store: one key, or all keys when key is omitted.",
    parameters: Type.Object({
      run_id: Type.String({ description: "The OrchestratorAI run id given in your task; empty if none." }),
      key: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: { run_id: string; key?: string }, _s: AbortSignal | undefined, _u: unknown, ctx: any) {
      const db = openStore(ctx.cwd);
      const run = resolveRun(db, params.run_id);
      return { content: [{ type: "text", text: JSON.stringify(db.getState(run.id, params.key), null, 2) }], details: {} };
    },
  });
}
