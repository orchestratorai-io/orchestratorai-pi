import XCTest
@testable import Pi

/// The app's half of the resume fixes (2026-11-23). The extension's half is in
/// `.pi/extensions/orchestrator/test/journal.test.ts`.
final class ResumeReliabilityTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-11-23T18:00:00Z")!

    private func iso(_ secondsAgo: TimeInterval) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: now.addingTimeInterval(-secondsAgo))
    }

    private func run(status: String = "running", workflow: String = "contract-review", title: String = "Contract Review — NDA",
                     model: String? = "qwen3.6:latest", ownerPid: Int32? = nil, heartbeatAgo: TimeInterval? = nil,
                     updatedAgo: TimeInterval = 3600) -> RunRecord {
        RunRecord(
            id: "run-1", workflow: workflow, title: title, sourceDocument: nil, params: [:], model: model,
            piRunId: "pi-1", status: status, error: nil, resultMarkdown: nil, agents: nil, resumes: 0,
            ownerPid: ownerPid, heartbeatAt: heartbeatAgo.map(iso),
            createdAt: iso(7200), startedAt: iso(7200), completedAt: nil, updatedAt: iso(updatedAgo)
        )
    }

    // MARK: 2. Runs marked stopped after 3 minutes while still waiting

    func testRunWaitingAtAGateForHoursIsNotMarkedStoppedWhileItsPiLives() {
        // Last journal event an hour ago (the gate writes none while it waits); Pi beat 20 s ago.
        let waiting = run(ownerPid: 777, heartbeatAgo: 20)
        XCTAssertFalse(RunLiveness.isOrphaned(run: waiting, lastEventAt: now.addingTimeInterval(-3600), now: now, pidAlive: { $0 == 777 }))
    }

    func testRunWhosePiIsGoneIsMarkedStoppedRightAway() {
        let dead = run(ownerPid: 777, heartbeatAgo: 20, updatedAgo: 5)
        XCTAssertTrue(RunLiveness.isOrphaned(run: dead, lastEventAt: now, now: now, pidAlive: { _ in false }))
    }

    func testPiThatShutDownOrStoppedBeatingCountsAsGone() {
        XCTAssertTrue(RunLiveness.isOrphaned(run: run(ownerPid: 777, heartbeatAgo: nil), lastEventAt: now, now: now, pidAlive: { _ in true }))
        XCTAssertTrue(RunLiveness.isOrphaned(run: run(ownerPid: 777, heartbeatAgo: 11 * 60), lastEventAt: now, now: now, pidAlive: { _ in true }))
    }

    func testOlderRowsWithoutAnOwnerKeepTheThreeMinuteRule() {
        XCTAssertTrue(RunLiveness.isOrphaned(run: run(), lastEventAt: now.addingTimeInterval(-181), now: now, pidAlive: { _ in true }))
        XCTAssertFalse(RunLiveness.isOrphaned(run: run(), lastEventAt: now.addingTimeInterval(-30), now: now, pidAlive: { _ in true }))
        XCTAssertFalse(RunLiveness.isOrphaned(run: run(status: "completed"), lastEventAt: nil, now: now, pidAlive: { _ in false }))
    }

    func testProcessAliveChecksARealProcess() {
        XCTAssertTrue(RunLiveness.processAlive(getpid()))
        XCTAssertFalse(RunLiveness.processAlive(0))
        XCTAssertFalse(RunLiveness.processAlive(Int32.max))
    }

    // MARK: 3. "Launching workflow" hangs with no timeout

    func testLaunchWithNoReplyTimesOutWithAClearMessage() {
        XCTAssertEqual(LaunchWatchdog.verdict(elapsed: 10, replied: false, runWentLive: false, command: "start"), .keepWaiting)
        guard case .timedOut(let message) = LaunchWatchdog.verdict(elapsed: LaunchWatchdog.timeout, replied: false, runWentLive: false, command: "resume") else {
            return XCTFail("a launch with no reply after \(LaunchWatchdog.timeout) s must time out")
        }
        XCTAssertTrue(message.contains("did not answer within 90 seconds"), message)
        XCTAssertTrue(message.contains("resume the workflow"), message)
        XCTAssertTrue(message.contains("pi --approve"), message)
    }

    func testLaunchThatGotItsReplyOrWentLiveIsNotTimedOut() {
        XCTAssertEqual(LaunchWatchdog.verdict(elapsed: 600, replied: true, runWentLive: false, command: "start"), .done)
        XCTAssertEqual(LaunchWatchdog.verdict(elapsed: 600, replied: false, runWentLive: true, command: "start"), .done)
    }

    // MARK: 6. Resume honours a hand-picked model

    func testResumeUsesTheModelPickedInTheApp() {
        XCTAssertEqual(ResumeModel.choose(picked: " qwen3.6:35b-mlx ", runModel: "qwen3.6:latest", fallback: ContentView.defaultModel), "qwen3.6:35b-mlx")
    }

    func testDefaultModelIsTheOneInstalledOnTheStudio() {
        XCTAssertEqual(ContentView.defaultModel, "qwen3.6:35b-mlx")
    }

    func testResumeWithAnEmptyBoxUsesTheRunsModelThenTheDefault() {
        XCTAssertEqual(ResumeModel.choose(picked: "", runModel: "qwen3-coder-next", fallback: ContentView.defaultModel), "qwen3-coder-next")
        XCTAssertEqual(ResumeModel.choose(picked: "  ", runModel: nil, fallback: ContentView.defaultModel), ContentView.defaultModel)
    }

    // MARK: 1. Junk "(resumed)" runs left by the old extension are hidden, not deleted

    func testOldResumeArtifactsAreHiddenFromTheRunList() {
        XCTAssertTrue(LegalWorkflowCatalog.isHiddenFromRunList(run(workflow: "inline", title: "Deal Memo — dealroom-diligence-record (resumed)")))
        XCTAssertFalse(LegalWorkflowCatalog.isHiddenFromRunList(run(workflow: "inline", title: "A TUI run")))
        XCTAssertFalse(LegalWorkflowCatalog.isHiddenFromRunList(run(title: "Contract Review — NDA (resumed)")))
        XCTAssertTrue(LegalWorkflowCatalog.isHiddenFromRunList(run(workflow: "prep-probe-coder")))
    }

    // MARK: 5. The app tells Pi a console is attached

    func testAppLaunchedPiIsMarkedAsHavingAConsole() {
        let env = PiEnvironment.processEnvironment(piExecutable: "/usr/bin/true")
        XCTAssertEqual(env[PiEnvironment.consoleEnvironmentKey], "1")
        XCTAssertEqual(PiEnvironment.consoleEnvironmentKey, "ORCHESTRATORAI_CONSOLE")
    }
}

/// The store reads the new liveness columns, also from a file made before they existed.
final class RunStoreLivenessColumnTests: XCTestCase {
    func testOwnerAndHeartbeatAreReadBackFromAStoreMadeBeforeTheyExisted() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pi-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let data = dir.appendingPathComponent("data")
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        let db = data.appendingPathComponent("orchestrator.sqlite").path
        // The runs table as it was before owner_pid and heartbeat_at.
        try sqlite(db, "CREATE TABLE runs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, title TEXT NOT NULL, source_document TEXT, params_json TEXT NOT NULL, model TEXT, pi_run_id TEXT, status TEXT NOT NULL, error TEXT, result_markdown TEXT, result_json TEXT, agents INTEGER, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL, flow_json TEXT, display TEXT, resume_offset INTEGER NOT NULL DEFAULT 0, resumes INTEGER NOT NULL DEFAULT 0);")
        let store = try XCTUnwrap(RunStore(projectDirectory: dir))
        try sqlite(db, "INSERT INTO runs (id, workflow, title, params_json, status, owner_pid, heartbeat_at, created_at, updated_at) VALUES ('r', 'contract-review', 'T', '{}', 'running', 4321, '2026-11-23T18:00:00.000Z', '2026-11-23T18:00:00.000Z', '2026-11-23T18:00:00.000Z');")
        let run = try XCTUnwrap(store.run(id: "r"))
        XCTAssertEqual(run.ownerPid, 4321)
        XCTAssertEqual(run.heartbeatAt, "2026-11-23T18:00:00.000Z")
    }

    private func sqlite(_ db: String, _ sql: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        process.arguments = [db, sql]
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, sql)
    }
}
