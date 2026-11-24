import XCTest
import SQLite3
@testable import Pi

/// 2026-11-23: attorney notes stay verbatim, and deleting a run deletes its contents.
final class VerbatimAndDeleteTests: XCTestCase {

    // MARK: 1. "Approved by attorney." inserted into verbatim answers

    func testApprovalKeepsTheNoteExactlyAsTyped() {
        let answer = "I don't recall signing that addendum.\nI was in Denver that week."
        let d = PiRunner.decision(approved: true, comment: answer)
        XCTAssertEqual(d.status, "approved")
        XCTAssertEqual(d.comment, answer)
    }

    func testChangesRequestedKeepsTheNoteExactlyAsTyped() {
        let d = PiRunner.decision(approved: false, comment: "Narrow the question to 2024.")
        XCTAssertEqual(d.status, "changes_requested")
        XCTAssertEqual(d.comment, "Narrow the question to 2024.")
    }

    func testEmptyNoteStaysEmptyAndOnlyTheStatusRecordsTheDecision() {
        // An empty cross-exam answer must reach the scorer empty, so it can end the simulation.
        XCTAssertEqual(PiRunner.decision(approved: true, comment: "  \n ").comment, "")
        XCTAssertEqual(PiRunner.decision(approved: false, comment: "").comment, "")
        for approved in [true, false] {
            XCTAssertFalse(PiRunner.decision(approved: approved, comment: "end simulation").comment.contains("attorney"))
        }
    }

    func testStoredDecisionCommentIsTheNoteAndStatusIsSeparate() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try seed(store.path, sql: "INSERT INTO checkpoints (id, run_id, kind, title, status, requested_at) VALUES ('cp-1', 'run-1', 'gate', 'Cross-examination', 'pending', '2026-11-23T18:00:00Z');")
        let d = PiRunner.decision(approved: true, comment: "No, never.")
        XCTAssertTrue(store.decide(checkpointId: "cp-1", status: d.status, comment: d.comment))
        let row = try rows(store.path, "SELECT status || '|' || decision_comment FROM checkpoints WHERE id = 'cp-1'")
        XCTAssertEqual(row, ["approved|No, never."])
    }

    // MARK: 2. Deleting a run leaves its contents behind

    func testDeleteRunRemovesEveryTableRowOfThatRunAndNoOtherRun() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        for id in ["gone", "kept"] {
            try seed(store.path, sql: """
            INSERT INTO runs (id, workflow, title, params_json, status, created_at, updated_at) VALUES ('\(id)', 'contract-review', 'T', '{}', 'completed', '2026-11-23T18:00:00Z', '2026-11-23T18:00:00Z');
            INSERT INTO run_events (run_id, at, type, summary, detail) VALUES ('\(id)', '2026-11-23T18:00:00Z', 'node_session', 's', '/sessions/\(id).jsonl');
            INSERT INTO checkpoints (id, run_id, kind, title, status, requested_at) VALUES ('cp-\(id)', '\(id)', 'gate', 'G', 'approved', '2026-11-23T18:00:00Z');
            INSERT INTO evaluations (id, run_id, rubric, rubric_version, decision, answers_json, at) VALUES ('ev-\(id)', '\(id)', 'r', 1, 'pass', '{}', '2026-11-23T18:00:00Z');
            INSERT INTO run_progress (session_file, text, updated_at) VALUES ('/sessions/\(id).jsonl', 'privileged draft text', '2026-11-23T18:00:00Z');
            INSERT INTO run_state (run_id, key, value_json, reducer, updated_at) VALUES ('\(id)', 'k', '"v"', 'set', '2026-11-23T18:00:00Z');
            INSERT INTO step_overrides (run_id, step_index, value_json, at) VALUES ('\(id)', 0, '"edited"', '2026-11-23T18:00:00Z');
            """)
        }
        XCTAssertEqual(store.sessionFiles(runId: "gone"), ["/sessions/gone.jsonl"])
        XCTAssertTrue(store.deleteRun(id: "gone"))

        let checks: [(String, String)] = [
            ("runs", "id"), ("run_events", "run_id"), ("checkpoints", "run_id"), ("evaluations", "run_id"),
            ("run_state", "run_id"), ("step_overrides", "run_id"),
        ]
        for (table, column) in checks {
            XCTAssertEqual(try rows(store.path, "SELECT \(column) FROM \(table)"), ["kept"], table)
        }
        XCTAssertEqual(try rows(store.path, "SELECT session_file FROM run_progress"), ["/sessions/kept.jsonl"])
    }

    func testSessionFilesOfTheDeletedRunAreRemovedAndNothingOutsidePiSessions() throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("pi-delete-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: base) }
        let root = base.appendingPathComponent("sessions/pi-agents")
        let runFolder = root.appendingPathComponent("pi-run-1")
        try fm.createDirectory(at: runFolder, withIntermediateDirectories: true)
        let a = runFolder.appendingPathComponent("a.jsonl"), b = runFolder.appendingPathComponent("b.jsonl")
        let otherRun = root.appendingPathComponent("pi-run-2/c.jsonl")
        try fm.createDirectory(at: otherRun.deletingLastPathComponent(), withIntermediateDirectories: true)
        let outside = base.appendingPathComponent("matter.jsonl")
        let notSession = runFolder.appendingPathComponent("notes.md")
        for url in [a, b, otherRun, outside, notSession] { try Data("x".utf8).write(to: url) }

        let removed = SessionFiles.remove(
            [a.path, b.path, outside.path, notSession.path, root.appendingPathComponent("../../matter.jsonl").path, "/nonexistent/x.jsonl"],
            under: root
        )
        XCTAssertEqual(removed, 2)
        XCTAssertFalse(fm.fileExists(atPath: a.path))
        XCTAssertFalse(fm.fileExists(atPath: b.path))
        XCTAssertTrue(fm.fileExists(atPath: otherRun.path), "another run's session is untouched")
        XCTAssertTrue(fm.fileExists(atPath: outside.path), "nothing outside Pi's sessions folder is deleted")
        XCTAssertTrue(fm.fileExists(atPath: notSession.path), "only .jsonl session files are deleted")
        XCTAssertTrue(fm.fileExists(atPath: runFolder.path), "folder kept while it still has files")

        try fm.removeItem(at: notSession)
        let c = runFolder.appendingPathComponent("c.jsonl")
        try Data("x".utf8).write(to: c)
        SessionFiles.remove([c.path], under: root)
        XCTAssertFalse(fm.fileExists(atPath: runFolder.path), "an emptied session folder goes too")
        XCTAssertTrue(fm.fileExists(atPath: root.path), "the sessions root itself stays")
    }

    // MARK: helpers

    private func makeStore() throws -> (RunStore, URL) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pi-store-\(UUID().uuidString)")
        let store = try XCTUnwrap(RunStore(projectDirectory: dir))
        return (store, dir)
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
