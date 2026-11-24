import Foundation
import SQLite3

/// Reader (and attorney-decision writer) for the on-device run store that the
/// Pi extension maintains at `data/orchestrator.sqlite`. Same schema as
/// `.pi/extensions/orchestrator/store.ts`; WAL mode lets both processes hold
/// the file open at once.
struct RunRecord: Identifiable, Hashable {
    let id: String
    let workflow: String
    let title: String
    let sourceDocument: String?
    let params: [String: String]
    let model: String?
    let piRunId: String?
    let status: String          // queued | running | completed | failed | stopped
    let error: String?
    let resultMarkdown: String?
    let agents: Int?
    let resumes: Int
    /// Process id of the Pi driving the run (nil for rows from before it was recorded).
    var ownerPid: Int32? = nil
    /// Refreshed by that Pi every 30 s while it lives; cleared when it shuts down.
    var heartbeatAt: String? = nil
    let createdAt: String
    let startedAt: String?
    let completedAt: String?
    let updatedAt: String

    var isLive: Bool { status == "queued" || status == "running" }
}

struct RunEventRecord: Identifiable, Hashable {
    let id: Int
    let runId: String
    let at: String
    let type: String
    let nodeInstance: String?
    let agent: String?
    let summary: String
    let detail: String?

    var isFailure: Bool {
        type == "node_failed" || type == "start_failed" || (type == "run_completed" && !summary.hasPrefix("Workflow completed"))
    }
}

struct CheckpointRecord: Identifiable, Hashable {
    let id: String
    let runId: String
    let kind: String            // gate | final_review
    let title: String
    let summaryMarkdown: String?
    let status: String          // pending | approved | changes_requested | cancelled | timed_out
    let decisionComment: String?
    let requestedAt: String
    let decidedAt: String?

    var isPending: Bool { status == "pending" }
    var isGate: Bool { kind == "gate" }
    /// The gate waited its full time and nobody decided. Rows from before the
    /// `timed_out` status say `cancelled` with a "Timed out…" comment.
    var isTimedOut: Bool { status == "timed_out" }

    /// The status as the attorney reads it.
    var statusLabel: String {
        switch status {
        case "pending": return "Pending"
        case "approved": return "Approved"
        case "changes_requested": return "Changes requested"
        case "cancelled": return "Cancelled"
        case "timed_out": return "Timed out (no decision in time)"
        default: return status.replacingOccurrences(of: "_", with: " ")
        }
    }
}

/// One calibrated answer from a rubric question, reduced to its headline numbers.
struct EvaluationAnswer: Hashable {
    enum Kind: String, Hashable {
        case noul, score, choice
    }

    let questionId: String
    let kind: Kind
    /// Probability the statement is true (`noul` answers only).
    let noul: Double?
    /// Probability-weighted level (`score` answers only).
    let score: Double?
    /// Selected option (`choice` answers only).
    let choice: String?
    /// Calibrated confidence (`score` and `choice` answers; nouls carry none).
    let confidence: Double?

    /// e.g. `scripts_testimony 0.97`, `level 2.00 @1.00`, `severity HIGH @0.90`.
    var headline: String {
        func two(_ value: Double) -> String { String(format: "%.2f", value) }
        let tail: String
        switch kind {
        case .noul:
            tail = noul.map(two) ?? "?"
        case .score:
            tail = (score.map(two) ?? "?") + (confidence.map { " @" + two($0) } ?? "")
        case .choice:
            tail = (choice ?? "?") + (confidence.map { " @" + two($0) } ?? "")
        }
        return "\(questionId) \(tail)"
    }
}

/// A rubric check recorded against a run (`evaluations` table).
struct EvaluationRecord: Identifiable, Hashable {
    let id: String
    let runId: String?
    let rubric: String
    let rubricVersion: Int
    let decision: String        // pass | review | block
    let reason: String?
    let answers: [EvaluationAnswer]
    let answersJSON: String
    let statePreview: String?
    let model: String?
    let inputTokens: Int?
    let outputTokens: Int?
    let at: String

    var isBlock: Bool { decision == "block" }
    var isReview: Bool { decision == "review" }
}

/// Attorney-facing state derived from the engine status plus checkpoints.
enum ReviewState: Hashable {
    case queued
    case running
    case awaitingGate(CheckpointRecord)
    case awaitingReview
    case approved
    case changesRequested
    case failed
    case stopped

    var label: String {
        switch self {
        case .queued: return "Queued"
        case .running: return "Running"
        case .awaitingGate: return "Awaiting attorney decision"
        case .awaitingReview: return "Awaiting attorney review"
        case .approved: return "Approved"
        case .changesRequested: return "Changes requested"
        case .failed: return "Failed"
        case .stopped: return "Stopped"
        }
    }

    var needsAttention: Bool {
        switch self {
        case .awaitingGate, .awaitingReview, .changesRequested, .failed: return true
        default: return false
        }
    }

    var isLive: Bool {
        switch self {
        case .queued, .running, .awaitingGate: return true
        default: return false
        }
    }
}

/// What the human-review card offers when no final-review card is pending.
enum FinalReviewControl: Equatable {
    case none
    /// The run completed but has no pending final review (it was never created, or
    /// the last one was cancelled): without this it sat in Needs attention with no buttons.
    case start
    /// The attorney decided; they may reopen it.
    case reopen

    static func choose(state: ReviewState, checkpoints: [CheckpointRecord]) -> FinalReviewControl {
        if checkpoints.contains(where: { $0.kind == "final_review" && $0.isPending }) { return .none }
        switch state {
        case .awaitingReview: return .start
        case .approved, .changesRequested: return .reopen
        default: return .none
        }
    }
}

/// Everything the app shows from the store, read in one go off the main thread
/// (`PiRunner.refresh`) and published on it.
struct RunSnapshot: Sendable {
    var runs: [RunRecord] = []
    var checkpointsByRun: [String: [CheckpointRecord]] = [:]
    var evaluationCounts: [String: (block: Int, review: Int, pass: Int)] = [:]
    /// The selection the per-run lists below were read for.
    var selectedRunId: String?
    var events: [RunEventRecord] = []
    var stepOutputs: [RunStore.StepOutput] = []
    var liveText: [RunStore.LiveText] = []
    var evaluations: [EvaluationRecord] = []
    var reviewChecks: [String: Bool] = [:]

    /// A fixed number of queries whatever the number of runs (checkpoints come in one SELECT).
    static func load(from store: RunStore, selectedRunId: String?) -> RunSnapshot {
        var snapshot = RunSnapshot(selectedRunId: selectedRunId)
        // Model experiments stay in the store (hidden, not deleted); only the buyer's lists skip them.
        snapshot.runs = store.runs().filter { !LegalWorkflowCatalog.isHiddenFromRunList($0) }
        let all = store.checkpointsByRun()
        for run in snapshot.runs { snapshot.checkpointsByRun[run.id] = all[run.id] ?? [] }
        snapshot.evaluationCounts = store.evaluationSummary()
        if let selectedRunId {
            snapshot.events = store.events(runId: selectedRunId)
            snapshot.stepOutputs = store.stepOutputs(runId: selectedRunId)
            snapshot.liveText = store.liveText(runId: selectedRunId)
            snapshot.evaluations = store.evaluations(runId: selectedRunId)
            snapshot.reviewChecks = store.reviewChecks(runId: selectedRunId)
        }
        return snapshot
    }
}

/// `@unchecked Sendable`: the connection is opened `SQLITE_OPEN_FULLMUTEX`, so SQLite
/// serialises every call on it. The app still gives its background reads a connection
/// of their own (see `PiRunner`), so they never land inside a write transaction.
final class RunStore: @unchecked Sendable {
    private var db: OpaquePointer?
    let path: String

    init?(projectDirectory: URL) {
        let url = projectDirectory.appendingPathComponent("data/orchestrator.sqlite")
        path = url.path
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            return nil
        }
        exec("PRAGMA journal_mode = WAL;")
        exec("PRAGMA busy_timeout = 5000;")
        exec(Self.schema)
        migrate()
    }

    /// Columns added after the first release, the same list as `MIGRATIONS` in
    /// store.ts. `CREATE TABLE IF NOT EXISTS` leaves an older file's tables as they
    /// were, so without these the app reading a store Pi has not opened since an
    /// upgrade found no `step_index`/`value_json` and showed no step outputs.
    static let migrations: [(table: String, column: String, ddl: String)] = [
        ("runs", "flow_json", "ALTER TABLE runs ADD COLUMN flow_json TEXT"),
        ("runs", "display", "ALTER TABLE runs ADD COLUMN display TEXT"),
        ("runs", "resume_offset", "ALTER TABLE runs ADD COLUMN resume_offset INTEGER NOT NULL DEFAULT 0"),
        ("runs", "resumes", "ALTER TABLE runs ADD COLUMN resumes INTEGER NOT NULL DEFAULT 0"),
        ("run_events", "value_json", "ALTER TABLE run_events ADD COLUMN value_json TEXT"),
        ("run_events", "step_index", "ALTER TABLE run_events ADD COLUMN step_index INTEGER"),
        ("runs", "owner_pid", "ALTER TABLE runs ADD COLUMN owner_pid INTEGER"),
        ("runs", "heartbeat_at", "ALTER TABLE runs ADD COLUMN heartbeat_at TEXT"),
        ("runs", "origin", "ALTER TABLE runs ADD COLUMN origin TEXT"),
        ("runs", "resume_rebinds", "ALTER TABLE runs ADD COLUMN resume_rebinds INTEGER NOT NULL DEFAULT 0"),
        ("runs", "resume_claim_token", "ALTER TABLE runs ADD COLUMN resume_claim_token TEXT"),
    ]

    /// Applies `migrations` idempotently, in one write transaction so a Pi opening the
    /// store at the same moment takes turns with the app instead of racing on a column.
    /// A column the other side added in the meantime makes the ALTER fail harmlessly.
    private func migrate() {
        exec("BEGIN IMMEDIATE;")
        for m in Self.migrations where !columns(of: m.table).contains(m.column) {
            exec(m.ddl + ";")
        }
        exec("COMMIT;")
    }

    func columns(of table: String) -> Set<String> {
        Set(query("PRAGMA table_info(\(table))") { Self.text($0, named: "name") })
    }

    /// An ISO-8601 time with milliseconds, like Node's `toISOString()`. Node writes
    /// `…00.123Z`; a bare `…00Z` sorts after it within the same second (`.` < `Z`),
    /// which put the app's writes out of order against Pi's in `ORDER BY` on text.
    static func timestamp(_ date: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    deinit {
        if let db { sqlite3_close(db) }
    }

    // Mirrors store.ts so the app can open the file before Pi ever ran.
    private static let schema = """
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, workflow TEXT NOT NULL, title TEXT NOT NULL, source_document TEXT,
      params_json TEXT NOT NULL, model TEXT, pi_run_id TEXT, status TEXT NOT NULL, error TEXT,
      result_markdown TEXT, result_json TEXT, agents INTEGER, created_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
      flow_json TEXT, display TEXT, resume_offset INTEGER NOT NULL DEFAULT 0, resumes INTEGER NOT NULL DEFAULT 0,
      owner_pid INTEGER, heartbeat_at TEXT, resume_rebinds INTEGER NOT NULL DEFAULT 0, resume_claim_token TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_pi_run_id ON runs(pi_run_id);
    CREATE INDEX IF NOT EXISTS runs_created_at ON runs(created_at);
    CREATE TABLE IF NOT EXISTS run_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL,
      node_path TEXT, node_instance TEXT, node_kind TEXT, agent TEXT, label TEXT, summary TEXT NOT NULL,
      detail TEXT, payload_json TEXT, value_json TEXT, step_index INTEGER
    );
    CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, seq);
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      summary_markdown TEXT, status TEXT NOT NULL, decision_comment TEXT, requested_at TEXT NOT NULL,
      decided_at TEXT, node_instance TEXT
    );
    CREATE INDEX IF NOT EXISTS checkpoints_run ON checkpoints(run_id, requested_at);
    CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY, run_id TEXT, rubric TEXT NOT NULL, rubric_version INTEGER NOT NULL,
      decision TEXT NOT NULL, reason TEXT, answers_json TEXT NOT NULL, state_preview TEXT,
      model TEXT, input_tokens INTEGER, output_tokens INTEGER, at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS evaluations_run ON evaluations(run_id, at);
    CREATE TABLE IF NOT EXISTS run_progress (
      session_file TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_state (
      run_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, reducer TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY (run_id, key)
    );
    CREATE TABLE IF NOT EXISTS step_overrides (
      run_id TEXT NOT NULL, step_index INTEGER NOT NULL, value_json TEXT NOT NULL, note TEXT, at TEXT NOT NULL,
      PRIMARY KEY (run_id, step_index)
    );
    CREATE TABLE IF NOT EXISTS review_checks (
      run_id TEXT NOT NULL, item_id TEXT NOT NULL, checked INTEGER NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY (run_id, item_id)
    );
    """

    // MARK: Reads

    func runs() -> [RunRecord] {
        query("SELECT * FROM runs ORDER BY created_at DESC") { Self.run(from: $0) }
    }

    func run(id: String) -> RunRecord? {
        query("SELECT * FROM runs WHERE id = ?", bind: [id]) { Self.run(from: $0) }.first
    }

    func events(runId: String) -> [RunEventRecord] {
        query("SELECT seq, run_id, at, type, node_instance, agent, summary, detail FROM run_events WHERE run_id = ? ORDER BY seq", bind: [runId]) { stmt in
            RunEventRecord(
                id: Int(sqlite3_column_int64(stmt, 0)),
                runId: Self.text(stmt, 1) ?? "",
                at: Self.text(stmt, 2) ?? "",
                type: Self.text(stmt, 3) ?? "",
                nodeInstance: Self.text(stmt, 4),
                agent: Self.text(stmt, 5),
                summary: Self.text(stmt, 6) ?? "",
                detail: Self.text(stmt, 7)
            )
        }
    }

    func checkpoints(runId: String) -> [CheckpointRecord] {
        query("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY requested_at", bind: [runId]) { Self.checkpoint(from: $0) }
    }

    /// Every run's checkpoints, in request order, from one query.
    func checkpointsByRun() -> [String: [CheckpointRecord]] {
        Dictionary(grouping: query("SELECT * FROM checkpoints ORDER BY run_id, requested_at") { Self.checkpoint(from: $0) }, by: \.runId)
    }

    func pendingCheckpoints() -> [CheckpointRecord] {
        query("SELECT * FROM checkpoints WHERE status = 'pending' ORDER BY requested_at") { Self.checkpoint(from: $0) }
    }

    func evaluations(runId: String) -> [EvaluationRecord] {
        query("SELECT * FROM evaluations WHERE run_id = ? ORDER BY at", bind: [runId]) { Self.evaluation(from: $0) }
    }

    /// Decision counts per run, in one pass over the table.
    func evaluationSummary() -> [String: (block: Int, review: Int, pass: Int)] {
        let rows: [(String, Int, Int, Int)] = query(
            """
            SELECT run_id,
                   SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END),
                   SUM(CASE WHEN decision = 'review' THEN 1 ELSE 0 END),
                   SUM(CASE WHEN decision = 'pass' THEN 1 ELSE 0 END)
            FROM evaluations WHERE run_id IS NOT NULL GROUP BY run_id
            """
        ) { stmt in
            guard let runId = Self.text(stmt, 0) else { return nil }
            return (
                runId,
                Int(sqlite3_column_int64(stmt, 1)),
                Int(sqlite3_column_int64(stmt, 2)),
                Int(sqlite3_column_int64(stmt, 3))
            )
        }
        var summary: [String: (block: Int, review: Int, pass: Int)] = [:]
        for (runId, block, review, pass) in rows {
            summary[runId] = (block: block, review: review, pass: pass)
        }
        return summary
    }

    func reviewState(for run: RunRecord, checkpoints: [CheckpointRecord]) -> ReviewState {
        // A run that ended badly is that, whatever checkpoint it happened to be
        // holding. `markOrphaned` deliberately leaves a pending gate pending so a
        // resume can pick it back up — but if the gate won the state, an orphaned
        // run read as "Awaiting attorney decision" forever: the resume card is only
        // offered for a stopped or failed run, so the one run that needed resuming
        // was the one run that could not be. Terminal status comes first.
        switch run.status {
        case "failed": return .failed
        case "stopped": return .stopped
        default: break
        }
        if let gate = checkpoints.last(where: { $0.isGate && $0.isPending }) {
            return .awaitingGate(gate)
        }
        switch run.status {
        case "queued": return .queued
        case "running": return .running
        default: break
        }
        guard let final = checkpoints.last(where: { $0.kind == "final_review" }) else {
            return .awaitingReview
        }
        switch final.status {
        case "approved": return .approved
        case "changes_requested": return .changesRequested
        default: return .awaitingReview
        }
    }

    // MARK: Writes (attorney decisions only — the engine journal belongs to Pi)

    @discardableResult
    func decide(checkpointId: String, status: String, comment: String) -> Bool {
        let now = Self.timestamp()
        return execute(
            "UPDATE checkpoints SET status = ?, decision_comment = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
            bind: [status, comment, now, checkpointId]
        )
    }

    /// Opens a fresh final review of a completed run: "Reopen for review" after a
    /// decision, or "Start final review" when the run finished without one (see
    /// `FinalReviewControl`). The report is copied in as the card's summary, and
    /// nothing is added while a final review is already pending.
    @discardableResult
    func reopenFinalReview(runId: String) -> Bool {
        let now = Self.timestamp()
        return execute(
            """
            INSERT INTO checkpoints (id, run_id, kind, title, summary_markdown, status, requested_at)
            SELECT ?, id, 'final_review', 'Attorney review of final report', result_markdown, 'pending', ?
            FROM runs WHERE id = ? AND status = 'completed'
              AND NOT EXISTS (SELECT 1 FROM checkpoints WHERE run_id = ? AND kind = 'final_review' AND status = 'pending')
            """,
            bind: [UUID().uuidString.lowercased(), now, runId, runId]
        ) && changes() > 0
    }

    /// The session files of a run's delegated agents, as journaled in its node_session events.
    func sessionFiles(runId: String) -> [String] {
        query("SELECT DISTINCT detail FROM run_events WHERE run_id = ? AND type = 'node_session' AND detail IS NOT NULL", bind: [runId]) {
            Self.text($0, 0)
        }
    }

    /// Deletes everything the store holds for one run, in one transaction: its journal,
    /// gates, evaluations, step edits, checklist ticks, workflow state and its agents' live text. For a
    /// legal app "Delete" has to delete; the run's session files on disk are removed by
    /// `SessionFiles.remove` (the caller collects them with `sessionFiles(runId:)` first).
    @discardableResult
    func deleteRun(id: String) -> Bool {
        exec("BEGIN IMMEDIATE;")
        let ok = execute(
            "DELETE FROM run_progress WHERE session_file IN (SELECT detail FROM run_events WHERE run_id = ? AND type = 'node_session' AND detail IS NOT NULL)",
            bind: [id]
        )
            && execute("DELETE FROM step_overrides WHERE run_id = ?", bind: [id])
            && execute("DELETE FROM review_checks WHERE run_id = ?", bind: [id])
            && execute("DELETE FROM run_state WHERE run_id = ?", bind: [id])
            && execute("DELETE FROM run_events WHERE run_id = ?", bind: [id])
            && execute("DELETE FROM checkpoints WHERE run_id = ?", bind: [id])
            && execute("DELETE FROM evaluations WHERE run_id = ?", bind: [id])
            && execute("DELETE FROM runs WHERE id = ?", bind: [id])
        exec(ok ? "COMMIT;" : "ROLLBACK;")
        return ok
    }

    /// Marks a queued/running run as stopped when the Pi process died underneath it.
    /// Pending gates are left pending on purpose: a resume re-runs the gate step and
    /// the idempotent attorney_review tool picks the existing checkpoint back up.
    @discardableResult
    func markOrphaned(runId: String, message: String) -> Bool {
        let now = Self.timestamp()
        return execute(
            "UPDATE runs SET status = 'stopped', error = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running')",
            bind: [message, now, now, runId]
        )
    }

    /// The attorney pressed Stop: the run is stopped and its waiting gates are
    /// cancelled, in one transaction. Done here rather than left to the extension's
    /// `/orchestrator stop`, because the app ends the Pi process right after asking
    /// and that reply may never come. (`markOrphaned`, for a Pi that died, keeps
    /// gates pending on purpose so a resume picks them back up.)
    @discardableResult
    func markStoppedByUser(runId: String, message: String = "Stopped by the user.") -> Bool {
        exec("BEGIN IMMEDIATE;")
        let ok = markOrphaned(runId: runId, message: message)
            && cancelPendingCheckpoints(runId: runId, reason: message)
        exec(ok ? "COMMIT;" : "ROLLBACK;")
        return ok
    }

    @discardableResult
    func cancelPendingCheckpoints(runId: String, reason: String) -> Bool {
        let now = Self.timestamp()
        return execute(
            "UPDATE checkpoints SET status = 'cancelled', decision_comment = ?, decided_at = ? WHERE run_id = ? AND status = 'pending'",
            bind: [reason, now, runId]
        )
    }

    // MARK: Attorney checklist

    /// The attorney's ticks on a run's review checklist, by item id: true ticked,
    /// false unticked (an item the report had ticked that the attorney cleared).
    func reviewChecks(runId: String) -> [String: Bool] {
        let rows: [(String, Bool)] = query("SELECT item_id, checked FROM review_checks WHERE run_id = ?", bind: [runId]) { stmt in
            guard let item = Self.text(stmt, 0) else { return nil }
            return (item, sqlite3_column_int64(stmt, 1) != 0)
        }
        return Dictionary(rows, uniquingKeysWith: { _, last in last })
    }

    @discardableResult
    func setReviewCheck(runId: String, itemId: String, checked: Bool) -> Bool {
        execute(
            "INSERT OR REPLACE INTO review_checks (run_id, item_id, checked, at) VALUES (?, ?, ?, ?)",
            bind: [runId, itemId, checked ? "1" : "0", Self.timestamp()]
        )
    }

    // MARK: Live text

    struct LiveText: Identifiable, Hashable {
        let sessionFile: String
        let label: String
        let text: String
        let updatedAt: String
        var id: String { sessionFile }
    }

    /// What each still-running agent of a run is writing right now. Children write
    /// run_progress keyed by their session file; the parent's node_session event carries it.
    /// Only sessions opened since the run's latest resume count: an agent killed by a
    /// crash never journals node_completed, and its last text would otherwise show as live.
    func liveText(runId: String) -> [LiveText] {
        query(
            """
            SELECT e.detail, e.label, p.text, p.updated_at
            FROM run_events e JOIN run_progress p ON p.session_file = e.detail
            WHERE e.run_id = ? AND e.type = 'node_session'
              AND e.seq > COALESCE((SELECT MAX(r.seq) FROM run_events r WHERE r.run_id = e.run_id AND r.type = 'resume'), 0)
              AND NOT EXISTS (SELECT 1 FROM run_events d WHERE d.run_id = e.run_id AND d.node_instance = e.node_instance
                              AND d.type IN ('node_completed','node_failed','node_cancelled') AND d.seq > e.seq)
            ORDER BY p.updated_at DESC
            """,
            bind: [runId]
        ) { stmt in
            LiveText(sessionFile: Self.text(stmt, 0) ?? "", label: Self.text(stmt, 1) ?? "agent", text: Self.text(stmt, 2) ?? "", updatedAt: Self.text(stmt, 3) ?? "")
        }
    }

    // MARK: Resume support

    /// A completed top-level step of a run: what resume will re-bind, and what an attorney may edit first.
    struct StepOutput: Identifiable, Hashable {
        let stepIndex: Int
        let label: String
        let valueText: String
        let isOverridden: Bool
        var id: Int { stepIndex }
    }

    /// Each completed step as resume will use it: an attorney's saved edit
    /// (`step_overrides.value_json`) is shown in place of the stored output, so the
    /// card and a re-opened edit sheet start from the edit, not the original.
    func stepOutputs(runId: String) -> [StepOutput] {
        var overrides: [Int: String] = [:]
        let saved: [(Int, String)] = query("SELECT step_index, value_json FROM step_overrides WHERE run_id = ?", bind: [runId]) { stmt in
            (Int(sqlite3_column_int64(stmt, 0)), Self.text(stmt, 1) ?? "")
        }
        for (index, json) in saved { overrides[index] = json }
        return query(
            "SELECT step_index, label, value_json FROM run_events WHERE run_id = ? AND type = 'node_completed' AND step_index IS NOT NULL ORDER BY seq",
            bind: [runId]
        ) { stmt in
            let index = Int(sqlite3_column_int64(stmt, 0))
            let raw = overrides[index] ?? Self.text(stmt, 2) ?? ""
            return StepOutput(stepIndex: index, label: Self.text(stmt, 1) ?? "step \(index + 1)", valueText: Self.displayText(json: raw), isOverridden: overrides[index] != nil)
        }
        .reduce(into: [Int: StepOutput]()) { $0[$1.stepIndex] = $1 }   // latest completion per step wins
        .values.sorted { $0.stepIndex < $1.stepIndex }
    }

    /// A stored JSON value as the step card shows it: strings as themselves, anything else as pretty JSON.
    static func displayText(json raw: String) -> String {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(raw.utf8), options: [.fragmentsAllowed]) else { return raw }
        if let str = obj as? String { return str }
        guard let pretty = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) else { return raw }
        return String(data: pretty, encoding: .utf8) ?? raw
    }

    /// The JSON an edited step output is saved as. Text that parses as a JSON object
    /// or array is saved as that structure, because later steps read fields of it
    /// (`{inventory.items}`, `map.over`, `switch`) and a quoted string breaks them.
    /// Anything else, including bare numbers and `true`, stays the attorney's text.
    static func overrideJSON(for text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{") || trimmed.hasPrefix("[") {
            if let obj = try? JSONSerialization.jsonObject(with: Data(trimmed.utf8)),
               obj is [String: Any] || obj is [Any],
               let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) {
                return String(data: data, encoding: .utf8)
            }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: text, options: [.fragmentsAllowed]) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Attorney edit of a completed step's output; resume uses it instead of the stored value.
    @discardableResult
    func setStepOverride(runId: String, stepIndex: Int, text: String, note: String?) -> Bool {
        guard let json = Self.overrideJSON(for: text) else { return false }
        let now = Self.timestamp()
        return execute(
            "INSERT OR REPLACE INTO step_overrides (run_id, step_index, value_json, note, at) VALUES (?, ?, ?, ?, ?)",
            bind: [runId, String(stepIndex), json, note, now]
        )
    }

    @discardableResult
    func clearStepOverride(runId: String, stepIndex: Int) -> Bool {
        execute("DELETE FROM step_overrides WHERE run_id = ? AND step_index = ?", bind: [runId, String(stepIndex)])
    }

    // MARK: SQLite plumbing

    private func exec(_ sql: String) {
        sqlite3_exec(db, sql, nil, nil, nil)
    }

    /// Rows changed by the last statement on this connection.
    private func changes() -> Int {
        Int(sqlite3_changes(db))
    }

    private func execute(_ sql: String, bind: [String?]) -> Bool {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return false }
        defer { sqlite3_finalize(stmt) }
        Self.bind(bind, to: stmt)
        return sqlite3_step(stmt) == SQLITE_DONE
    }

    private func query<T>(_ sql: String, bind: [String?] = [], map: (OpaquePointer) -> T?) -> [T] {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        Self.bind(bind, to: stmt)
        var rows: [T] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let stmt, let row = map(stmt) { rows.append(row) }
        }
        return rows
    }

    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private static func bind(_ values: [String?], to stmt: OpaquePointer?) {
        for (index, value) in values.enumerated() {
            if let value {
                sqlite3_bind_text(stmt, Int32(index + 1), value, -1, transient)
            } else {
                sqlite3_bind_null(stmt, Int32(index + 1))
            }
        }
    }

    private static func text(_ stmt: OpaquePointer, _ column: Int32) -> String? {
        guard let cString = sqlite3_column_text(stmt, column) else { return nil }
        return String(cString: cString)
    }

    private static func column(_ stmt: OpaquePointer, _ name: String) -> Int32? {
        for index in 0..<sqlite3_column_count(stmt) {
            if let cName = sqlite3_column_name(stmt, index), String(cString: cName) == name { return index }
        }
        return nil
    }

    private static func text(_ stmt: OpaquePointer, named name: String) -> String? {
        guard let index = column(stmt, name) else { return nil }
        return text(stmt, index)
    }

    private static func int(_ stmt: OpaquePointer, named name: String) -> Int? {
        guard let index = column(stmt, name), sqlite3_column_type(stmt, index) != SQLITE_NULL else { return nil }
        return Int(sqlite3_column_int64(stmt, index))
    }

    private static func run(from stmt: OpaquePointer) -> RunRecord? {
        guard let id = text(stmt, named: "id") else { return nil }
        let paramsJSON = text(stmt, named: "params_json") ?? "{}"
        let params = (try? JSONSerialization.jsonObject(with: Data(paramsJSON.utf8)) as? [String: Any])?
            .compactMapValues { $0 as? String } ?? [:]
        return RunRecord(
            id: id,
            workflow: text(stmt, named: "workflow") ?? "",
            title: text(stmt, named: "title") ?? id,
            sourceDocument: text(stmt, named: "source_document"),
            params: params,
            model: text(stmt, named: "model"),
            piRunId: text(stmt, named: "pi_run_id"),
            status: text(stmt, named: "status") ?? "queued",
            error: text(stmt, named: "error"),
            resultMarkdown: text(stmt, named: "result_markdown"),
            agents: int(stmt, named: "agents"),
            resumes: int(stmt, named: "resumes") ?? 0,
            ownerPid: int(stmt, named: "owner_pid").map { Int32(truncatingIfNeeded: $0) },
            heartbeatAt: text(stmt, named: "heartbeat_at"),
            createdAt: text(stmt, named: "created_at") ?? "",
            startedAt: text(stmt, named: "started_at"),
            completedAt: text(stmt, named: "completed_at"),
            updatedAt: text(stmt, named: "updated_at") ?? ""
        )
    }

    private static func checkpoint(from stmt: OpaquePointer) -> CheckpointRecord? {
        guard let id = text(stmt, named: "id") else { return nil }
        return CheckpointRecord(
            id: id,
            runId: text(stmt, named: "run_id") ?? "",
            kind: text(stmt, named: "kind") ?? "gate",
            title: text(stmt, named: "title") ?? "",
            summaryMarkdown: text(stmt, named: "summary_markdown"),
            status: text(stmt, named: "status") ?? "pending",
            decisionComment: text(stmt, named: "decision_comment"),
            requestedAt: text(stmt, named: "requested_at") ?? "",
            decidedAt: text(stmt, named: "decided_at")
        )
    }

    private static func evaluation(from stmt: OpaquePointer) -> EvaluationRecord? {
        guard let id = text(stmt, named: "id") else { return nil }
        let answersJSON = text(stmt, named: "answers_json") ?? "{}"
        return EvaluationRecord(
            id: id,
            runId: text(stmt, named: "run_id"),
            rubric: text(stmt, named: "rubric") ?? "",
            rubricVersion: int(stmt, named: "rubric_version") ?? 0,
            decision: text(stmt, named: "decision") ?? "review",
            reason: text(stmt, named: "reason"),
            answers: answers(fromJSON: answersJSON),
            answersJSON: answersJSON,
            statePreview: text(stmt, named: "state_preview"),
            model: text(stmt, named: "model"),
            inputTokens: int(stmt, named: "input_tokens"),
            outputTokens: int(stmt, named: "output_tokens"),
            at: text(stmt, named: "at") ?? ""
        )
    }

    /// `{ "<questionId>": { "type": "noul", "noul": 0.97 } | { "type": "score", "score": 2.0, "confidence": 1.0, ... } | { "type": "choice", "choice": "x", "confidence": 0.9, ... } }`
    private static func answers(fromJSON json: String) -> [EvaluationAnswer] {
        guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return [] }
        func number(_ value: Any?) -> Double? {
            if let number = value as? NSNumber { return number.doubleValue }
            if let string = value as? String { return Double(string) }
            return nil
        }
        return object.keys.sorted().compactMap { questionId in
            guard let answer = object[questionId] as? [String: Any],
                  let kind = (answer["type"] as? String).flatMap(EvaluationAnswer.Kind.init(rawValue:)) else { return nil }
            return EvaluationAnswer(
                questionId: questionId,
                kind: kind,
                noul: kind == .noul ? number(answer["noul"]) : nil,
                score: kind == .score ? number(answer["score"]) : nil,
                choice: kind == .choice ? answer["choice"] as? String : nil,
                confidence: kind == .noul ? nil : number(answer["confidence"])
            )
        }
    }
}

/// Removes the on-disk Pi session files of a run the user deleted in the app. Only
/// `.jsonl` files inside Pi's sessions folder are touched, so a stray path in the
/// journal can never delete anything else; a session folder left empty goes too.
enum SessionFiles {
    static var defaultRoot: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".pi/agent/sessions", isDirectory: true)
    }

    /// The paths that are safe to delete: real `.jsonl` files under `root`.
    static func deletable(_ paths: [String], under root: URL) -> [URL] {
        let rootPath = root.standardizedFileURL.resolvingSymlinksInPath().path + "/"
        return paths.compactMap { path in
            let url = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
            guard url.pathExtension == "jsonl", url.path.hasPrefix(rootPath) else { return nil }
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue else { return nil }
            return url
        }
    }

    @discardableResult
    static func remove(_ paths: [String], under root: URL = defaultRoot) -> Int {
        let fm = FileManager.default
        let rootPath = root.standardizedFileURL.resolvingSymlinksInPath().path
        var removed = 0
        for url in deletable(paths, under: root) {
            guard (try? fm.removeItem(at: url)) != nil else { continue }
            removed += 1
            let folder = url.deletingLastPathComponent()
            if folder.path != rootPath, (try? fm.contentsOfDirectory(atPath: folder.path))?.isEmpty == true {
                try? fm.removeItem(at: folder)
            }
        }
        return removed
    }
}
