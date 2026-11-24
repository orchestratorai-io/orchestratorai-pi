import XCTest
@testable import Pi

/// The app's half of the 2026-11-23 Omarchy review fixes to resume. The extension's half
/// is in `.pi/extensions/orchestrator/test/review-fixes.test.ts` and `runtime.test.ts`.
final class ResumeReviewFixesTests: XCTestCase {
    private func run(model: String?) -> RunRecord {
        RunRecord(
            id: "run-1", workflow: "contract-review", title: "Contract Review — NDA", sourceDocument: nil, params: [:], model: model,
            piRunId: "pi-1", status: "stopped", error: nil, resultMarkdown: nil, agents: nil, resumes: 0,
            ownerPid: nil, heartbeatAt: nil,
            createdAt: "2026-11-23T17:00:00.000Z", startedAt: "2026-11-23T17:00:00.000Z", completedAt: nil, updatedAt: "2026-11-23T17:30:00.000Z"
        )
    }

    // MARK: 1. The run opened at launch fills the "Local model" box

    func testRunOpenedAtLaunchFillsTheModelBoxSoResumeKeepsItsModel() {
        // The app opens the newest run itself; the box starts on the default model.
        let box = ResumeModel.boxValue(opening: run(model: "qwen3.6:latest"), current: ContentView.defaultModel)
        XCTAssertEqual(box, "qwen3.6:latest")
        // Resume with the box left alone runs on the run's own model, not the default.
        XCTAssertEqual(ResumeModel.choose(picked: box, runModel: "qwen3.6:latest", fallback: ContentView.defaultModel), "qwen3.6:latest")
    }

    func testRunWithNoRecordedModelLeavesTheModelBoxAlone() {
        XCTAssertEqual(ResumeModel.boxValue(opening: run(model: nil), current: "typed-model"), "typed-model")
        XCTAssertEqual(ResumeModel.boxValue(opening: run(model: "  "), current: "typed-model"), "typed-model")
        XCTAssertEqual(ResumeModel.boxValue(opening: nil, current: "typed-model"), "typed-model")
        XCTAssertEqual(ResumeModel.boxValue(opening: run(model: " qwen3.6:35b-mlx\n"), current: "x"), "qwen3.6:35b-mlx")
    }

    // MARK: 4. Launch watchdog: monotonic clock, keeps waiting when it wakes early

    func testWatchdogThatWakesEarlyWaitsOutTheRest() {
        XCTAssertEqual(LaunchWatchdog.verdict(elapsed: 89.9, replied: false, runWentLive: false, command: "start"), .keepWaiting)
        XCTAssertEqual(LaunchWatchdog.remaining(elapsed: 10), LaunchWatchdog.timeout - 10, accuracy: 0.0001)
        // Never a zero or negative wait, so the loop cannot spin.
        XCTAssertEqual(LaunchWatchdog.remaining(elapsed: 89.99), LaunchWatchdog.minimumRecheck)
        XCTAssertEqual(LaunchWatchdog.remaining(elapsed: 500), LaunchWatchdog.minimumRecheck)
        // Waiting out the rest then reaches the timeout.
        let after = 10 + LaunchWatchdog.remaining(elapsed: 10)
        guard case .timedOut = LaunchWatchdog.verdict(elapsed: after, replied: false, runWentLive: false, command: "start") else {
            return XCTFail("the second wake must time out")
        }
    }

    func testWatchdogMeasuresContinuousClockDurations() {
        XCTAssertEqual(LaunchWatchdog.seconds(.seconds(90)), 90, accuracy: 0.0001)
        XCTAssertEqual(LaunchWatchdog.seconds(.milliseconds(1500)), 1.5, accuracy: 0.0001)
        let clock = ContinuousClock()
        let start = clock.now
        XCTAssertGreaterThanOrEqual(LaunchWatchdog.seconds(clock.now - start), 0)
    }
}
