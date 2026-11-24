import XCTest
import SQLite3
@testable import Pi

/// 2026-11-23: a gate that timed out is stored as `timed_out` and the app says so plainly.
final class GateTimedOutTests: XCTestCase {

    func testTimedOutCheckpointReadsBackAndShowsPlainly() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pi-store-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try XCTUnwrap(RunStore(projectDirectory: dir))
        var db: OpaquePointer?
        guard sqlite3_open(store.path, &db) == SQLITE_OK else { throw XCTSkip("cannot open store") }
        let sql = """
        INSERT INTO checkpoints (id, run_id, kind, title, status, decision_comment, requested_at, decided_at)
        VALUES ('cp-1', 'run-1', 'gate', 'Approve the exhibit list', 'timed_out', 'No attorney decision was recorded in time.', '2026-11-23T18:00:00Z', '2026-11-24T06:00:00Z');
        """
        XCTAssertEqual(sqlite3_exec(db, sql, nil, nil, nil), SQLITE_OK)
        sqlite3_close(db)

        let checkpoint = try XCTUnwrap(store.checkpoints(runId: "run-1").first)
        XCTAssertTrue(checkpoint.isTimedOut)
        XCTAssertFalse(checkpoint.isPending, "a timed-out gate is not waiting for a decision any more")
        XCTAssertEqual(checkpoint.statusLabel, "Timed out (no decision in time)")
    }

    func testStatusLabels() {
        func label(_ status: String) -> String {
            CheckpointRecord(id: "c", runId: "r", kind: "gate", title: "T", summaryMarkdown: nil, status: status,
                             decisionComment: nil, requestedAt: "", decidedAt: nil).statusLabel
        }
        XCTAssertEqual(label("approved"), "Approved")
        XCTAssertEqual(label("changes_requested"), "Changes requested")
        XCTAssertEqual(label("cancelled"), "Cancelled", "older timed-out rows stay cancelled, as the brief allows")
        XCTAssertEqual(label("timed_out"), "Timed out (no decision in time)")
    }

    func testTimedOutGateDoesNotHoldTheRunAtAwaitingDecision() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pi-store-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try XCTUnwrap(RunStore(projectDirectory: dir))
        let run = RunRecord(id: "run-1", workflow: "w", title: "t", sourceDocument: nil, params: [:], model: nil, piRunId: nil,
                            status: "running", error: nil, resultMarkdown: nil, agents: nil, resumes: 0,
                            createdAt: "", startedAt: nil, completedAt: nil, updatedAt: "")
        let timedOut = CheckpointRecord(id: "c", runId: "run-1", kind: "gate", title: "T", summaryMarkdown: nil, status: "timed_out",
                                        decisionComment: nil, requestedAt: "", decidedAt: nil)
        XCTAssertEqual(store.reviewState(for: run, checkpoints: [timedOut]), .running)
    }
}
