import XCTest
import SQLite3
@testable import Pi

/// 2026-11-23 review P3 items 17-23 on the app side: live text after a resume,
/// store migrations and timestamps, one-query checkpoints, the attorney checklist,
/// `.env` parsing and the folder preview.
final class P3CleanupsTests: XCTestCase {

    // MARK: 17. Stale live text after a crash and resume

    func testLiveTextIgnoresSessionsOpenedBeforeTheLatestResume() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try seed(store.path, sql: """
        INSERT INTO runs (id, workflow, title, params_json, status, created_at, updated_at) VALUES ('r', 'contract-review', 'T', '{}', 'running', '2026-11-23T18:00:00.000Z', '2026-11-23T18:00:00.000Z');
        INSERT INTO run_events (run_id, at, type, node_instance, label, summary, detail) VALUES ('r', '2026-11-23T18:00:01.000Z', 'node_session', 'n1', 'red-blue', 's', '/s/before.jsonl');
        INSERT INTO run_progress (session_file, text, updated_at) VALUES ('/s/before.jsonl', 'text from the crashed agent', '2026-11-23T18:00:02.000Z');
        """)
        XCTAssertEqual(store.liveText(runId: "r").map(\.sessionFile), ["/s/before.jsonl"], "live before any resume")

        try seed(store.path, sql: """
        INSERT INTO run_events (run_id, at, type, summary) VALUES ('r', '2026-11-23T18:05:00.000Z', 'resume', 'Resuming from step 1 (1st resume)');
        """)
        XCTAssertEqual(store.liveText(runId: "r"), [], "the crashed agent never completed, but it is not live after the resume")

        try seed(store.path, sql: """
        INSERT INTO run_events (run_id, at, type, node_instance, label, summary, detail) VALUES ('r', '2026-11-23T18:05:01.000Z', 'node_session', 'n1', 'red-blue', 's', '/s/after.jsonl');
        INSERT INTO run_progress (session_file, text, updated_at) VALUES ('/s/after.jsonl', 'new text', '2026-11-23T18:05:02.000Z');
        """)
        XCTAssertEqual(store.liveText(runId: "r").map(\.text), ["new text"])
    }

    // MARK: 18. Migrations and timestamps

    func testOpeningAPreMigrationStoreAddsEveryLaterColumn() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pi-store-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("data"), withIntermediateDirectories: true)
        // The first release's runs and run_events, before any ALTER TABLE.
        try seed(dir.appendingPathComponent("data/orchestrator.sqlite").path, sql: """
        CREATE TABLE runs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, title TEXT NOT NULL, source_document TEXT,
          params_json TEXT NOT NULL, model TEXT, pi_run_id TEXT, status TEXT NOT NULL, error TEXT,
          result_markdown TEXT, result_json TEXT, agents INTEGER, created_at TEXT NOT NULL,
          started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL);
        CREATE TABLE run_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL,
          node_path TEXT, node_instance TEXT, node_kind TEXT, agent TEXT, label TEXT, summary TEXT NOT NULL,
          detail TEXT, payload_json TEXT);
        INSERT INTO runs (id, workflow, title, params_json, status, created_at, updated_at) VALUES ('old', 'contract-review', 'T', '{}', 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        """)
        let store = try XCTUnwrap(RunStore(projectDirectory: dir))
        for m in RunStore.migrations {
            XCTAssertTrue(store.columns(of: m.table).contains(m.column), "\(m.table).\(m.column)")
        }
        XCTAssertEqual(store.run(id: "old")?.resumes, 0)
        try seed(store.path, sql: """
        INSERT INTO run_events (run_id, at, type, label, summary, value_json, step_index) VALUES ('old', '2026-01-01T00:00:01.000Z', 'node_completed', 'review', 'c', '"findings"', 0);
        """)
        XCTAssertEqual(store.stepOutputs(runId: "old").map(\.valueText), ["findings"])
        // A second open (the columns now exist) is a no-op, not an error.
        XCTAssertNotNil(RunStore(projectDirectory: dir))
    }

    func testMigrationFailsAtAHeldWriteLockWithoutAddingAnyColumns() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pi-store-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("data"), withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("data/orchestrator.sqlite").path
        try seed(path, sql: """
        CREATE TABLE runs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, title TEXT NOT NULL, source_document TEXT,
          params_json TEXT NOT NULL, model TEXT, pi_run_id TEXT, status TEXT NOT NULL, error TEXT,
          result_markdown TEXT, result_json TEXT, agents INTEGER, created_at TEXT NOT NULL,
          started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL);
        CREATE TABLE run_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL,
          node_path TEXT, node_instance TEXT, node_kind TEXT, agent TEXT, label TEXT, summary TEXT NOT NULL,
          detail TEXT, payload_json TEXT);
        """)

        var blocker: OpaquePointer?
        XCTAssertEqual(sqlite3_open(path, &blocker), SQLITE_OK)
        defer { sqlite3_close(blocker) }
        XCTAssertEqual(sqlite3_exec(blocker, "BEGIN IMMEDIATE", nil, nil, nil), SQLITE_OK)

        XCTAssertNil(RunStore(projectDirectory: dir, busyTimeoutMilliseconds: 20))

        XCTAssertEqual(sqlite3_exec(blocker, "ROLLBACK", nil, nil, nil), SQLITE_OK)
        var check: OpaquePointer?
        XCTAssertEqual(sqlite3_open(path, &check), SQLITE_OK)
        defer { sqlite3_close(check) }
        for migration in RunStore.migrations {
            XCTAssertFalse(columns(of: migration.table, in: check).contains(migration.column), migration.column)
        }
    }

    func testMigrationListMatchesStoreTs() throws {
        let storeTs = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".pi/extensions/orchestrator/store.ts")
        let source = try String(contentsOf: storeTs, encoding: .utf8)
        let regex = try NSRegularExpression(pattern: #"\{ table: "(\w+)", column: "(\w+)", ddl: "([^"]+)" \}"#)
        let ts = regex.matches(in: source, range: NSRange(source.startIndex..., in: source)).map { match in
            (0..<3).map { String(source[Range(match.range(at: $0 + 1), in: source)!]) }
        }
        XCTAssertEqual(ts, RunStore.migrations.map { [$0.table, $0.column, $0.ddl] })
    }

    func testTimestampsCarryMillisecondsLikeNode() {
        let date = Date(timeIntervalSince1970: 1_795_000_000.25)
        let stamp = RunStore.timestamp(date)
        XCTAssertNotNil(stamp.range(of: #"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$"#, options: .regularExpression), stamp)
        XCTAssertTrue(stamp.hasSuffix(".250Z"))
        // Same second: Node's earlier ".100Z" must sort before the app's ".250Z".
        let node = String(stamp.dropLast(5)) + ".100Z"
        XCTAssertLessThan(node, stamp)
    }

    func testAppWritesSortWithNodeWritesInTheSameSecond() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try seed(store.path, sql: """
        INSERT INTO runs (id, workflow, title, params_json, status, created_at, updated_at) VALUES ('r', 'contract-review', 'T', '{}', 'completed', '2026-11-23T18:00:00.000Z', '2026-11-23T18:00:00.000Z');
        INSERT INTO checkpoints (id, run_id, kind, title, status, requested_at) VALUES ('later', 'r', 'gate', 'G', 'approved', '\(String(RunStore.timestamp().prefix(19))).999Z');
        """)
        XCTAssertTrue(store.reopenFinalReview(runId: "r"))
        // The app's row was written after Node's, but within that second it has a
        // smaller fraction, so it sorts first; what matters is it has one at all.
        let requested = store.checkpoints(runId: "r").map(\.requestedAt)
        XCTAssertTrue(requested.allSatisfy { $0.range(of: #"\.\d{3}Z$"#, options: .regularExpression) != nil }, "\(requested)")
    }

    // MARK: 19. One query for checkpoints; the snapshot the runner publishes

    func testCheckpointsByRunGroupsAllRunsInRequestOrder() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try seed(store.path, sql: """
        INSERT INTO runs (id, workflow, title, params_json, status, created_at, updated_at) VALUES ('a', 'contract-review', 'A', '{}', 'running', '2026-11-23T18:00:00.000Z', '2026-11-23T18:00:00.000Z');
        INSERT INTO runs (id, workflow, title, params_json, status, created_at, updated_at) VALUES ('b', 'contract-review', 'B', '{}', 'running', '2026-11-23T18:00:01.000Z', '2026-11-23T18:00:01.000Z');
        INSERT INTO checkpoints (id, run_id, kind, title, status, requested_at) VALUES ('a2', 'a', 'gate', 'G2', 'pending', '2026-11-23T18:00:02.000Z');
        INSERT INTO checkpoints (id, run_id, kind, title, status, requested_at) VALUES ('a1', 'a', 'gate', 'G1', 'approved', '2026-11-23T18:00:01.000Z');
        INSERT INTO checkpoints (id, run_id, kind, title, status, requested_at) VALUES ('b1', 'b', 'gate', 'G', 'pending', '2026-11-23T18:00:03.000Z');
        INSERT INTO run_events (run_id, at, type, summary) VALUES ('b', '2026-11-23T18:00:01.000Z', 'queued', 'Queued');
        """)
        let grouped = store.checkpointsByRun()
        XCTAssertEqual(grouped["a"]?.map(\.id), ["a1", "a2"])
        XCTAssertEqual(grouped["b"]?.map(\.id), ["b1"])
        XCTAssertEqual(grouped["a"], store.checkpoints(runId: "a"))

        let snapshot = RunSnapshot.load(from: store, selectedRunId: "b")
        XCTAssertEqual(snapshot.runs.map(\.id), ["b", "a"])
        XCTAssertEqual(snapshot.checkpointsByRun["a"]?.count, 2)
        XCTAssertEqual(snapshot.selectedRunId, "b")
        XCTAssertEqual(snapshot.events.map(\.type), ["queued"])
        XCTAssertEqual(RunSnapshot.load(from: store, selectedRunId: nil).events, [])
    }

    // MARK: 21. Attorney checklist

    func testChecklistKeepsSubheadingsAndEndsAtASameLevelHeading() {
        let markdown = """
        # Report
        ## Attorney review focus
        - [ ] HIGH — Indemnity is uncapped; negotiate a cap
        ### Commercial
        - [x] MEDIUM — Payment terms are net 90; confirm
        * [ ] LOW — Notice address missing
        #### Detail
        - [X] LOW — Typo in clause 4
        ## Recommended next workflow
        - [ ] Not part of the checklist
        """
        let items = ContentView.parseAttorneyItems(from: markdown)
        XCTAssertEqual(items.map(\.text), [
            "Indemnity is uncapped; negotiate a cap",
            "Payment terms are net 90; confirm",
            "Notice address missing",
            "Typo in clause 4",
        ])
        XCTAssertEqual(items.map(\.severity), ["HIGH", "MEDIUM", "LOW", "LOW"])
        XCTAssertEqual(items.map(\.checkedInReport), [false, true, false, true])
    }

    func testChecklistUnderAnH3EndsAtTheNextH2() {
        let markdown = """
        ### Issues requiring attorney review
        - [ ] HIGH — One
        ## Appendix
        - [ ] HIGH — Not this
        """
        XCTAssertEqual(ContentView.parseAttorneyItems(from: markdown).map(\.text), ["One"])
    }

    func testSavedTicksOverrideTheReportAndSurviveInTheStore() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let items = ContentView.parseAttorneyItems(from: """
        ## Attorney review focus
        - [ ] HIGH — A
        - [x] LOW — B
        - [ ] LOW — C
        """)
        XCTAssertEqual(AttorneyReviewItem.reviewedIDs(items, saved: [:]), [items[1].id], "the report's own tick counts")

        try seed(store.path, sql: """
        INSERT INTO runs (id, workflow, title, params_json, status, created_at, updated_at) VALUES ('r', 'contract-review', 'T', '{}', 'completed', '2026-11-23T18:00:00.000Z', '2026-11-23T18:00:00.000Z');
        INSERT INTO runs (id, workflow, title, params_json, status, created_at, updated_at) VALUES ('other', 'contract-review', 'T', '{}', 'completed', '2026-11-23T18:00:00.000Z', '2026-11-23T18:00:00.000Z');
        """)
        XCTAssertTrue(store.setReviewCheck(runId: "r", itemId: items[0].id, checked: true))
        XCTAssertTrue(store.setReviewCheck(runId: "r", itemId: items[1].id, checked: false))
        XCTAssertTrue(store.setReviewCheck(runId: "other", itemId: items[2].id, checked: true))

        let reopened = try XCTUnwrap(RunStore(projectDirectory: dir))
        let saved = reopened.reviewChecks(runId: "r")
        XCTAssertEqual(AttorneyReviewItem.reviewedIDs(items, saved: saved), [items[0].id], "A ticked, B unticked, C untouched")
        XCTAssertEqual(RunSnapshot.load(from: reopened, selectedRunId: "r").reviewChecks, saved)

        XCTAssertTrue(reopened.deleteRun(id: "r"))
        XCTAssertEqual(reopened.reviewChecks(runId: "r"), [:], "Delete deletes the ticks too")
        XCTAssertEqual(reopened.reviewChecks(runId: "other").count, 1)
    }

    // MARK: 22. .env parsing

    func testDotEnvHandlesExportAndInlineComments() {
        let env = PiEnvironment.parseDotEnv("""
        # comment line
        export DECISION_BASE_URL=http://localhost:11434/v1   # local Ollama
        export\tTABBED=yes
        PLAIN=value
        HASH_IN_WORD=abc#def
        QUOTED="has # inside" # trailing comment
        SINGLE='x # y'
        EMPTY= # nothing
        SPACED = spaced value
        UNCLOSED="oops
        not a pair
        """)
        XCTAssertEqual(env["DECISION_BASE_URL"], "http://localhost:11434/v1")
        XCTAssertEqual(env["TABBED"], "yes")
        XCTAssertEqual(env["PLAIN"], "value")
        XCTAssertEqual(env["HASH_IN_WORD"], "abc#def")
        XCTAssertEqual(env["QUOTED"], "has # inside")
        XCTAssertEqual(env["SINGLE"], "x # y")
        XCTAssertEqual(env["EMPTY"], "")
        XCTAssertEqual(env["SPACED"], "spaced value")
        XCTAssertEqual(env["UNCLOSED"], "\"oops")
        XCTAssertNil(env["export DECISION_BASE_URL"])
        XCTAssertEqual(env.count, 9)
    }

    // MARK: 23. Folder preview

    func testFolderSourcePreviewListsTheFolder() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("pi-folder-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: dir) }
        try fm.createDirectory(at: dir.appendingPathComponent("exhibits"), withIntermediateDirectories: true)
        for name in ["b.md", "a.pdf", "doc10.md", "doc2.md", ".DS_Store"] {
            try Data("x".utf8).write(to: dir.appendingPathComponent(name))
        }
        XCTAssertEqual(SourcePreview.load(dir), .folder(entries: ["a.pdf", "b.md", "doc2.md", "doc10.md", "exhibits/"], more: 0))
        XCTAssertEqual(SourcePreview.load(dir, maxEntries: 2), .folder(entries: ["a.pdf", "b.md"], more: 3))
        XCTAssertEqual(SourcePreview.load(dir.appendingPathComponent("b.md")), .text("x"))
        try Data([0xFF, 0xFE, 0x00, 0xD8]).write(to: dir.appendingPathComponent("bin.dat"))
        XCTAssertEqual(SourcePreview.load(dir.appendingPathComponent("bin.dat")), .unreadable)
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

    private func columns(of table: String, in db: OpaquePointer?) -> Set<String> {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "PRAGMA table_info(\(table))", -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        var result = Set<String>()
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let text = sqlite3_column_text(stmt, 1) { result.insert(String(cString: text)) }
        }
        return result
    }
}
