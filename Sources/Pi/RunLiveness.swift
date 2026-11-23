import Foundation

/// Decisions about runs and the Pi processes behind them, kept free of UI and
/// process plumbing so `Tests/PiTests` can check them.
enum RunLiveness {
    /// Rows from before Pi recorded its process id: live if journalled to within this long.
    static let legacyStaleAfter: TimeInterval = 180
    /// A live owner pid whose heartbeat (refreshed every 30 s) is older than this is
    /// taken for a reused pid, not a live run. Same as HEARTBEAT_STALE_MS in journal.ts.
    static let heartbeatStaleAfter: TimeInterval = 10 * 60

    /// Whether a run the store still has as queued/running has no Pi behind it any more.
    ///
    /// Pi now records which process drives a run and refreshes a heartbeat while it lives,
    /// so a run waiting hours at an attorney gate, or on a slow model, is not mistaken for
    /// a dead one. It used to be: the only signal was the last journal event, and a gate
    /// writes none while it waits, so after 3 minutes the run was marked stopped.
    static func isOrphaned(run: RunRecord, lastEventAt: Date?, now: Date, pidAlive: (Int32) -> Bool) -> Bool {
        guard run.isLive else { return false }
        if let pid = run.ownerPid {
            guard pidAlive(pid) else { return true }
            guard let beat = run.heartbeatAt.flatMap(parseISO) else { return true }   // that Pi shut down
            return now.timeIntervalSince(beat) > heartbeatStaleAfter
        }
        let lastActivity = [lastEventAt, parseISO(run.updatedAt)].compactMap { $0 }.max()
        guard let lastActivity else { return false }
        return now.timeIntervalSince(lastActivity) > legacyStaleAfter
    }

    /// `kill(pid, 0)`: the process exists (EPERM means it exists but is not ours).
    static func processAlive(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }

    static func parseISO(_ value: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

/// How long "Launching workflow…" may wait for the extension's `/orchestrator` reply.
///
/// The reply normally arrives within a few seconds (pi-agents' own `start` call gives up
/// after 15). If the extension never loaded (project not trusted, a load error, missing
/// dependencies), Pi does not handle the command and no reply ever comes; the screen used
/// to stay on "Launching workflow…" until someone pressed Stop.
struct LaunchWatchdog {
    /// Generous on purpose: Pi loads its packages before it reads the command.
    static let timeout: TimeInterval = 90

    enum Verdict: Equatable {
        case keepWaiting
        case done
        case timedOut(message: String)
    }

    static func verdict(elapsed: TimeInterval, replied: Bool, runWentLive: Bool, command: String) -> Verdict {
        if replied || runWentLive { return .done }
        guard elapsed >= timeout else { return .keepWaiting }
        let action = command == "resume" ? "resume the workflow" : "start the workflow"
        return .timedOut(message: "Pi did not answer within \(Int(timeout)) seconds, so it could not \(action). Usually the OrchestratorAI extension did not load: open Terminal in the project folder and run `pi --approve` to see the error, and check that Ollama is running. Nothing was changed; try again once Pi starts.")
    }
}

/// Which model a resume runs on.
enum ResumeModel {
    /// The model in the app's "Local model" box wins: opening a run fills that box with the
    /// run's own model, so leaving it alone resumes on the same model, and typing another
    /// one (say, because the first is not installed) resumes on that. An empty box falls
    /// back to the run's model, then the app default.
    static func choose(picked: String, runModel: String?, fallback: String) -> String {
        let picked = picked.trimmingCharacters(in: .whitespacesAndNewlines)
        if !picked.isEmpty { return picked }
        if let runModel = runModel?.trimmingCharacters(in: .whitespacesAndNewlines), !runModel.isEmpty { return runModel }
        return fallback
    }
}
