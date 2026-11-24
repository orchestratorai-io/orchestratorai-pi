/**
 * Process-wide state of the orchestrator extension: the run-database link and
 * the heartbeat timer. Kept apart from index.ts so it can be tested without Pi
 * (see test/runtime.test.ts).
 *
 * Pi (0.85) fires `session_shutdown` with reason "quit" | "reload" | "new" |
 * "resume" | "fork". Only "quit" ends the process. For the other four Pi drops
 * this copy of the extension (and its event-bus subscriptions) and loads a new
 * one, while pi-agents runs go on. So the store and the heartbeat must outlive
 * a single copy: closing the store dropped run events until the next
 * session_start, and the new copy's empty run map stopped the heartbeat of a
 * run waiting at an attorney gate, which then looked dead after 10 minutes.
 */

import { RunStore } from "./store.ts";
import { HEARTBEAT_MS, type Journal } from "./journal.ts";

/** session_shutdown reasons that replace this extension copy but keep the Pi process (and its runs) alive. */
export const REPLACEMENT_REASONS: ReadonlySet<string> = new Set(["reload", "new", "resume", "fork"]);

/** Whether a session_shutdown ends the Pi process. A missing or unknown reason is treated as a real shutdown. */
export function endsProcess(reason: unknown): boolean {
  return !(typeof reason === "string" && REPLACEMENT_REASONS.has(reason));
}

type SharedState = {
  store?: RunStore;
  projectDir?: string;
  journal?: Journal;
  timer?: ReturnType<typeof setInterval>;
  copies: number;
};

export interface RuntimeOptions {
  /** globalThis slot holding the shared state; tests pass their own. */
  key?: symbol;
  openStore?: (projectDir: string) => RunStore;
  heartbeatMs?: number;
}

const DEFAULT_KEY = Symbol.for("orchestratorai.pi.extension-runtime");

export class ExtensionRuntime {
  /** True when an earlier copy of the extension ran in this process (a reload or session switch). */
  readonly inherited: boolean;
  private readonly key: symbol;
  private readonly state: SharedState;
  private readonly open: (projectDir: string) => RunStore;
  private readonly journal: Journal;

  constructor(journal: Journal, opts: RuntimeOptions = {}) {
    this.journal = journal;
    this.key = opts.key ?? DEFAULT_KEY;
    const slots = globalThis as unknown as Record<symbol, SharedState | undefined>;
    this.state = slots[this.key] ??= { copies: 0 };
    this.open = opts.openStore ?? ((dir) => new RunStore(dir));
    this.inherited = this.state.copies > 0;
    this.state.copies++;
    // The newest copy drives the heartbeat; it has the current run map.
    this.state.journal = journal;
    if (!this.state.timer) {
      // While this Pi drives a run, say so in the store every HEARTBEAT_MS. A run waiting
      // hours at an attorney gate writes no journal events, and without this the app took
      // that silence for a dead Pi and marked the run stopped.
      this.state.timer = setInterval(() => this.state.journal?.heartbeat(), opts.heartbeatMs ?? HEARTBEAT_MS);
      this.state.timer.unref?.();
    }
    if (this.inherited && this.state.store) journal.adopt(this.state.store);
  }

  get store(): RunStore | undefined {
    return this.state.store;
  }

  get projectDir(): string | undefined {
    return this.state.projectDir;
  }

  /** The open store, opening it for this project if none is open yet. */
  ensureStore(projectDir: string): RunStore {
    return this.state.store ?? this.openFor(projectDir);
  }

  /**
   * session_start: keep the store an earlier copy opened, unless the new
   * session is in a different project. Re-adopt this process's runs when a
   * copy ran here before; in a fresh process a matching pid is a reused one.
   */
  sessionStore(projectDir: string): RunStore {
    if (this.state.store && this.state.projectDir !== projectDir) {
      // A switch to another project: nothing here heartbeats the old project's runs any more.
      this.state.journal?.release();
      this.state.store.close();
      this.state.store = undefined;
    }
    const db = this.ensureStore(projectDir);
    if (this.inherited) this.journal.adopt(db);
    return db;
  }

  private openFor(projectDir: string): RunStore {
    this.state.projectDir = projectDir;
    this.state.store = this.open(projectDir);
    return this.state.store;
  }

  /**
   * session_shutdown. A reload or session switch keeps the store and heartbeat
   * for the next copy. A real shutdown releases this Pi's runs, stops the
   * heartbeat and closes the store. Returns whether it was a real shutdown.
   */
  shutdown(reason: unknown): boolean {
    if (!endsProcess(reason)) return false;
    if (this.state.timer) clearInterval(this.state.timer);
    this.state.timer = undefined;
    this.journal.release();
    this.state.store?.close();
    this.state.store = undefined;
    this.state.journal = undefined;
    delete (globalThis as unknown as Record<symbol, SharedState | undefined>)[this.key];
    return true;
  }
}
