import XCTest
import SQLite3
@testable import Pi

/// 2026-11-23 review leftovers, app side: structured step edits (5), Stop (8),
/// a completed run with no final review (11). Items 9-11's extension halves are
/// tested in `.pi/extensions/orchestrator/test/overrides-stop-resume.test.ts`.
final class OverridesStopResumeTests: XCTestCase {

    // MARK: 5. Structured step overrides

    func testJSONObjectAndArrayEditsAreSavedAsStructures() {
        XCTAssertEqual(RunStore.overrideJSON(for: "{\n  \"items\": [\"a\", \"b\"],\n  \"count\": 2\n}"), #"{"count":2,"items":["a","b"]}"#)
        XCTAssertEqual(RunStore.overrideJSON(for: "  [1, {\"x\": true}]\n"), #"[1,{"x":true}]"#)
    }

    func testPlainTextAndNonContainerJSONStayStrings() {
        XCTAssertEqual(RunStore.overrideJSON(for: "Narrow to 2024."), #""Narrow to 2024.""#)
        // Looks like JSON but is not: kept as the attorney's text.
        XCTAssertEqual(RunStore.overrideJSON(for: "{ not json"), #""{ not json""#)
        // Bare scalars are text an attorney typed, not a structure.
        XCTAssertEqual(RunStore.overrideJSON(for: "42"), #""42""#)
        XCTAssertEqual(RunStore.overrideJSON(for: "true"), #""true""#)
    }

    func testSavedStructuredOverrideIsWhatResumeReadsAndWhatTheCardShows() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try seedRun(store.path, id: "run-5", status: "stopped")
        try seed(store.path, sql: """
        INSERT INTO run_events (run_id, at, type, label, summary, value_json, step_index)
        VALUES ('run-5', '2026-11-23T18:00:00Z', 'node_completed', 'inventory', 'Completed inventory', '{"items":["original"]}', 0),
               ('run-5', '2026-11-23T18:00:01Z', 'node_completed', 'report', 'Completed report', '"draft"', 1);
        """)
        XCTAssertTrue(store.setStepOverride(runId: "run-5", stepIndex: 0, text: "{\"items\": [\"edited\", \"added\"]}", note: nil))
        XCTAssertTrue(store.setStepOverride(runId: "run-5", stepIndex: 1, text: "final wording", note: nil))

        // The extension JSON.parses value_json: an object, not a quoted string.
        XCTAssertEqual(try rows(store.path, "SELECT value_json FROM step_overrides WHERE run_id = 'run-5' ORDER BY step_index"),
                       [#"{"items":["edited","added"]}"#, #""final wording""#])

        let outputs = store.stepOutputs(runId: "run-5")
        XCTAssertEqual(outputs.map(\.isOverridden), [true, true])
        XCTAssertEqual(outputs[0].valueText, "{\n  \"items\" : [\n    \"edited\",\n    \"added\"\n  ]\n}")
        XCTAssertEqual(outputs[1].valueText, "final wording")

        // Revert brings the stored output back.
        XCTAssertTrue(store.clearStepOverride(runId: "run-5", stepIndex: 0))
        let reverted = store.stepOutputs(runId: "run-5")
        XCTAssertFalse(reverted[0].isOverridden)
        XCTAssertTrue(reverted[0].valueText.contains("original"))
    }

    // MARK: 8. Stop

    func testStopByUserStopsTheRunAndCancelsItsWaitingGatesOnly() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try seedRun(store.path, id: "run-8", status: "running")
        try seedRun(store.path, id: "other", status: "running")
        try seed(store.path, sql: """
        INSERT INTO checkpoints (id, run_id, kind, title, status, requested_at) VALUES
          ('g-wait', 'run-8', 'gate', 'Approve?', 'pending', '2026-11-23T18:00:00Z'),
          ('g-done', 'run-8', 'gate', 'Earlier', 'approved', '2026-11-23T17:00:00Z'),
          ('g-other', 'other', 'gate', 'Approve?', 'pending', '2026-11-23T18:00:00Z');
        """)
        XCTAssertTrue(store.markStoppedByUser(runId: "run-8"))
        XCTAssertEqual(try rows(store.path, "SELECT status || '|' || error FROM runs WHERE id = 'run-8'"), ["stopped|Stopped by the user."])
        XCTAssertEqual(try rows(store.path, "SELECT id || '|' || status FROM checkpoints ORDER BY id"),
                       ["g-done|approved", "g-other|pending", "g-wait|cancelled"])
        let run = try XCTUnwrap(store.run(id: "run-8"))
        XCTAssertEqual(store.reviewState(for: run, checkpoints: store.checkpoints(runId: "run-8")), .stopped)
        XCTAssertTrue(store.pendingCheckpoints().allSatisfy { $0.runId == "other" })
    }

    func testOrphanedRunsStillKeepTheirGatesPendingForResume() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try seedRun(store.path, id: "run-8", status: "running")
        try seed(store.path, sql: "INSERT INTO checkpoints (id, run_id, kind, title, status, requested_at) VALUES ('g', 'run-8', 'gate', 'Approve?', 'pending', '2026-11-23T18:00:00Z');")
        XCTAssertTrue(store.markOrphaned(runId: "run-8", message: "Pi exited."))
        XCTAssertEqual(try rows(store.path, "SELECT status FROM checkpoints"), ["pending"])
    }

    func testTerminatingPiEndsItsGrandchildrenToo() throws {
        let pidFile = FileManager.default.temporaryDirectory.appendingPathComponent("pi-grandchild-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: pidFile) }
        // Pi -> delegated agent (inner sh) -> its own process (sleep): a grandchild of Pi.
        let pi = Process()
        pi.executableURL = URL(fileURLWithPath: "/bin/sh")
        pi.arguments = ["-c", "/bin/sh -c 'sleep 60 & echo $! > \"$1\"; wait' inner \"$0\" & wait", pidFile.path]
        try pi.run()
        defer { if pi.isRunning { kill(pi.processIdentifier, SIGKILL) } }

        let grandchild = try waitForPid(in: pidFile)
        XCTAssertTrue(ProcessTree.ownsGroup(pid: pi.processIdentifier), "Process should start Pi as its own group leader")
        XCTAssertFalse(ProcessTree.ownsGroup(pid: getpid()), "the app's own group must never be signalled")
        XCTAssertEqual(kill(grandchild, 0), 0)

        ProcessTree.terminate(pid: pi.processIdentifier)
        pi.terminate()
        let deadline = Date().addingTimeInterval(5)
        while kill(grandchild, 0) == 0 && Date() < deadline { usleep(50_000) }
        XCTAssertNotEqual(kill(grandchild, 0), 0, "a grandchild of Pi survived Stop")
    }

    // MARK: 11. Completed run with no final review

    func testCompletedRunWithoutFinalReviewOffersStartFinalReview() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try seedRun(store.path, id: "run-11", status: "completed", result: "# The report")
        let run = try XCTUnwrap(store.run(id: "run-11"))
        XCTAssertEqual(store.reviewState(for: run, checkpoints: []), .awaitingReview)
        XCTAssertEqual(FinalReviewControl.choose(state: .awaitingReview, checkpoints: []), .start)

        XCTAssertTrue(store.reopenFinalReview(runId: "run-11"))
        let checkpoints = store.checkpoints(runId: "run-11")
        XCTAssertEqual(checkpoints.count, 1)
        XCTAssertEqual(checkpoints.first?.kind, "final_review")
        XCTAssertTrue(checkpoints.first?.isPending == true)
        XCTAssertEqual(checkpoints.first?.summaryMarkdown, "# The report")
        XCTAssertEqual(FinalReviewControl.choose(state: store.reviewState(for: run, checkpoints: checkpoints), checkpoints: checkpoints), .none)

        // A second press adds no second pending card.
        XCTAssertFalse(store.reopenFinalReview(runId: "run-11"))
        XCTAssertEqual(store.checkpoints(runId: "run-11").count, 1)
    }

    func testCancelledFinalReviewAlsoOffersStartAndDecidedOnesOfferReopen() throws {
        let cancelled = checkpoint(kind: "final_review", status: "cancelled")
        XCTAssertEqual(FinalReviewControl.choose(state: .awaitingReview, checkpoints: [cancelled]), .start)
        XCTAssertEqual(FinalReviewControl.choose(state: .approved, checkpoints: [checkpoint(kind: "final_review", status: "approved")]), .reopen)
        XCTAssertEqual(FinalReviewControl.choose(state: .changesRequested, checkpoints: []), .reopen)
        XCTAssertEqual(FinalReviewControl.choose(state: .running, checkpoints: []), .none)
        XCTAssertEqual(FinalReviewControl.choose(state: .stopped, checkpoints: []), .none)
    }

    func testStartFinalReviewIsRefusedForARunThatDidNotComplete() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try seedRun(store.path, id: "run-f", status: "failed")
        XCTAssertFalse(store.reopenFinalReview(runId: "run-f"))
        XCTAssertTrue(store.checkpoints(runId: "run-f").isEmpty)
    }

    // MARK: helpers

    private func checkpoint(kind: String, status: String) -> CheckpointRecord {
        CheckpointRecord(id: UUID().uuidString, runId: "r", kind: kind, title: "t", summaryMarkdown: nil, status: status,
                         decisionComment: nil, requestedAt: "2026-11-23T18:00:00Z", decidedAt: nil)
    }

    private func waitForPid(in file: URL) throws -> Int32 {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if let text = try? String(contentsOf: file, encoding: .utf8),
               let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)) { return pid }
            usleep(50_000)
        }
        throw XCTSkip("the test's grandchild process never started")
    }

    private func makeStore() throws -> (RunStore, URL) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pi-store-\(UUID().uuidString)")
        let store = try XCTUnwrap(RunStore(projectDirectory: dir))
        return (store, dir)
    }

    private func seedRun(_ path: String, id: String, status: String, result: String? = nil) throws {
        let resultSQL = result.map { "'\($0)'" } ?? "NULL"
        try seed(path, sql: """
        INSERT INTO runs (id, workflow, title, params_json, status, result_markdown, created_at, updated_at)
        VALUES ('\(id)', 'contract-review', 'T', '{}', '\(status)', \(resultSQL), '2026-11-23T18:00:00Z', '2026-11-23T18:00:00Z');
        """)
    }

    private func seed(_ path: String, sql: String) throws {
        var db: OpaquePointer?
        guard sqlite3_open(path, &db) == SQLITE_OK else { throw XCTSkip("cannot open store") }
        defer { sqlite3_close(db) }
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
            let message = err.map { String(cString: $0) } ?? "?"
            sqlite3_free(err)
            XCTFail("seed failed: \(message)")
        }
    }

    private func rows(_ path: String, _ sql: String) throws -> [String] {
        var db: OpaquePointer?
        guard sqlite3_open(path, &db) == SQLITE_OK else { throw XCTSkip("cannot open store") }
        defer { sqlite3_close(db) }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { XCTFail("bad sql \(sql)"); return [] }
        defer { sqlite3_finalize(stmt) }
        var out: [String] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            out.append(sqlite3_column_text(stmt, 0).map { String(cString: $0) } ?? "")
        }
        return out
    }
}
