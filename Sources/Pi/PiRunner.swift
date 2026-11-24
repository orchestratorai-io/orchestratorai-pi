import Foundation

/// Drives one Pi RPC process per launched run and mirrors the on-device run
/// store into published state. The store — not the RPC stream — is the source
/// of truth: the extension journals everything there, and this class only
/// listens to RPC for the deterministic `/orchestrator` reply and hard errors.
@MainActor
final class PiRunner: ObservableObject {
    @Published var runs: [RunRecord] = []
    @Published var checkpointsByRun: [String: [CheckpointRecord]] = [:]
    @Published var selectedRunId: String?
    @Published var events: [RunEventRecord] = []
    @Published var evaluations: [EvaluationRecord] = []
    @Published var stepOutputs: [RunStore.StepOutput] = []
    @Published var liveText: [RunStore.LiveText] = []
    @Published var evaluationCounts: [String: (block: Int, review: Int, pass: Int)] = [:]
    @Published var status = "Ready"
    @Published var isRunning = false
    @Published var errorMessage: String?
    @Published var storeUnavailable = false

    private(set) var store: RunStore?
    private var projectDirectory: URL?
    private var process: Process?
    private var inputPipe: Pipe?
    private var outputPipe: Pipe?
    private let lineBuffer = LineBuffer()
    private var activeRunId: String?
    /// Whether the active run has been observed live since this process launched it.
    /// Until it has, a non-live store state means "the extension has not written yet",
    /// not "the run is over".
    private var activeRunWentLive = false
    /// Whether the extension has answered the current `/orchestrator` launch command.
    private var launchReplied = false
    private var launchWatchdog: Task<Void, Never>?
    // Store change notification: SQLite in WAL mode appends to <db>-wal on every
    // commit, so watching that file (and the db, for checkpoints) with a
    // dispatch source wakes us on writes instead of polling. A slow fallback
    // timer covers the rare case where the -wal file is recreated.
    private var storeWatchers: [DispatchSourceFileSystemObject] = []
    private var fallbackTimer: Timer?
    private var refreshCoalescer: DispatchWorkItem?

    var selectedRun: RunRecord? {
        runs.first { $0.id == selectedRunId }
    }

    func checkpoints(for runId: String) -> [CheckpointRecord] {
        checkpointsByRun[runId] ?? []
    }

    func reviewState(for run: RunRecord) -> ReviewState {
        store?.reviewState(for: run, checkpoints: checkpoints(for: run.id)) ?? .queued
    }

    /// The most severe rubric decision recorded for a run: block > review > pass; nil when no rubric ran.
    func worstDecision(for runId: String) -> String? {
        guard let counts = evaluationCounts[runId] else { return nil }
        if counts.block > 0 { return "block" }
        if counts.review > 0 { return "review" }
        if counts.pass > 0 { return "pass" }
        return nil
    }

    var attentionRuns: [RunRecord] {
        runs.filter { reviewState(for: $0).needsAttention || reviewState(for: $0).isLive }
    }

    var completedRuns: [RunRecord] {
        runs.filter { reviewState(for: $0) == .approved }
    }

    // MARK: Store

    func attach(projectDirectory: URL) {
        self.projectDirectory = projectDirectory
        store = RunStore(projectDirectory: projectDirectory)
        storeUnavailable = store == nil
        markOrphanedRuns()
        refresh()
        if selectedRunId == nil { selectedRunId = runs.first?.id }
        schedulePolling()
    }

    func refresh() {
        guard let store else { return }
        // Model experiments stay in the store (hidden, not deleted); only the buyer's lists skip them.
        runs = store.runs().filter { !LegalWorkflowCatalog.isHiddenFromRunList($0) }
        var map: [String: [CheckpointRecord]] = [:]
        for run in runs { map[run.id] = store.checkpoints(runId: run.id) }
        checkpointsByRun = map
        evaluationCounts = store.evaluationSummary()
        if let selectedRunId {
            events = store.events(runId: selectedRunId)
            stepOutputs = store.stepOutputs(runId: selectedRunId)
            liveText = store.liveText(runId: selectedRunId)
            evaluations = store.evaluations(runId: selectedRunId)
        } else {
            events = []
            stepOutputs = []
            liveText = []
            evaluations = []
        }
        if let activeRunId, let run = runs.first(where: { $0.id == activeRunId }) {
            let state = reviewState(for: run)
            status = state.label
            // Only tear the process down once the run has actually been live under it.
            // A resume launches Pi against a run the store still has as `stopped`, and
            // `launchPi` ends by refreshing — so this used to kill the Pi process it had
            // just started, before the extension had written a single row. The button
            // did nothing at all, with no error, while the same RPC worked from a shell.
            if state.isLive {
                activeRunWentLive = true
            } else if activeRunWentLive {
                finishActiveProcess()
            }
        }
    }

    private func schedulePolling() {
        stopWatching()
        guard let store else { return }
        for path in [store.path, store.path + "-wal"] {
            // The -wal file may not exist until the first write; the fallback timer re-arms us.
            let fd = open(path, O_EVTONLY)
            guard fd >= 0 else { continue }
            let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .extend, .delete, .rename], queue: .main)
            source.setEventHandler { [weak self] in
                guard let self else { return }
                let flags = source.data
                self.scheduleRefresh()
                if flags.contains(.delete) || flags.contains(.rename) {
                    // The file was replaced (e.g. WAL checkpoint/truncate); re-open our watchers.
                    self.schedulePolling()
                }
            }
            source.setCancelHandler { close(fd) }
            source.resume()
            storeWatchers.append(source)
        }
        fallbackTimer = Timer.scheduledTimer(withTimeInterval: 10.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.refresh()
                // Re-arm if the -wal appeared after we started (first write of a fresh store).
                if self.storeWatchers.count < 2, let store = self.store, FileManager.default.fileExists(atPath: store.path + "-wal") {
                    self.schedulePolling()
                }
            }
        }
    }

    /// Coalesce bursts of writes (a run emits many events in quick succession) into one refresh.
    private func scheduleRefresh() {
        refreshCoalescer?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.refresh() }
        refreshCoalescer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
    }

    private func stopWatching() {
        for source in storeWatchers { source.cancel() }
        storeWatchers.removeAll()
        fallbackTimer?.invalidate()
        fallbackTimer = nil
    }

    func select(runId: String?) {
        selectedRunId = runId
        refresh()
    }

    // MARK: Launch

    func start(workflow: WorkflowDefinition, params: [String: String], sourceDocument: String, model: String) {
        let runId = UUID().uuidString.lowercased()
        let documentTitle = sourceDocument.hasPrefix("/")
            ? URL(fileURLWithPath: sourceDocument).deletingPathExtension().lastPathComponent
            : sourceDocument
        let request: [String: Any] = [
            "runId": runId,
            "workflow": workflow.id,
            "title": "\(workflow.title) — \(documentTitle)",
            "sourceDocument": sourceDocument,
            "params": params,
            "model": model
        ]
        launchPi(command: "start", request: request, runId: runId, model: model)
    }

    /// Crash-resume: the extension rebuilds the remainder of the stored flow from the
    /// completed steps' values (and any attorney overrides) and starts it under the same run id.
    /// `model` is what the "Local model" box holds; see `ResumeModel.choose`.
    func resume(run: RunRecord, model picked: String, fallbackModel: String) {
        let model = ResumeModel.choose(picked: picked, runModel: run.model, fallback: fallbackModel)
        launchPi(command: "resume", request: ["runId": run.id, "model": model], runId: run.id, model: model)
    }

    /// One Pi RPC process per launch; `/orchestrator <command> {json}` is the only thing sent.
    private func launchPi(command: String, request: [String: Any], runId: String, model: String) {
        guard let projectDirectory else { return }
        guard let piPath = PiEnvironment.findPiExecutable() else {
            errorMessage = "Could not find the `pi` executable. Install it with `npm i -g @earendil-works/pi-coding-agent` or set PI_PATH."
            return
        }
        stop()
        guard let json = try? JSONSerialization.data(withJSONObject: request),
              let jsonText = String(data: json, encoding: .utf8) else {
            errorMessage = "Could not encode the launch request."
            return
        }

        activeRunId = runId
        activeRunWentLive = false
        launchReplied = false
        selectedRunId = runId
        isRunning = true
        status = "Starting Pi…"

        let process = Process()
        let input = Pipe()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: piPath)
        process.arguments = [
            "--mode", "rpc",
            "--approve",
            "--no-session",
            "--provider", "ollama",
            "--model", model
        ]
        process.currentDirectoryURL = projectDirectory
        process.environment = PiEnvironment.processEnvironment(piExecutable: piPath, projectDirectory: projectDirectory)
        process.standardInput = input
        process.standardOutput = output
        process.standardError = output

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            self?.consume(data)
        }

        process.terminationHandler = { [weak self] process in
            Task { @MainActor in
                guard let self else { return }
                // The handler fires asynchronously, so by the time it runs a *newer*
                // launch may already own `activeRunId` (launchPi stops the previous
                // process first). Act only for the run this process was started for,
                // or a relaunch marks the run it just started as orphaned.
                guard self.activeRunId == runId else { return }
                self.outputPipe?.fileHandleForReading.readabilityHandler = nil
                self.isRunning = false
                if let activeRunId = self.activeRunId, let run = self.store?.run(id: activeRunId), run.isLive {
                    let reason = process.terminationStatus == 0
                        ? "Pi exited before the workflow finished."
                        : "Pi stopped (exit \(process.terminationStatus)). Check that Ollama is running and the model is available."
                    self.store?.markOrphaned(runId: activeRunId, message: reason)
                    self.errorMessage = reason
                }
                self.activeRunId = nil
                self.refresh()
            }
        }

        do {
            try process.run()
            self.process = process
            inputPipe = input
            outputPipe = output
            send(["type": "prompt", "message": "/orchestrator \(command) \(jsonText)"])
            status = command == "resume" ? "Resuming workflow…" : "Launching workflow…"
            armLaunchWatchdog(command: command, runId: runId)
        } catch {
            isRunning = false
            activeRunId = nil
            status = "Unavailable"
            errorMessage = "Could not start Pi: \(error.localizedDescription)"
        }
        refresh()
    }

    /// Give up on a launch the extension never answers (see `LaunchWatchdog`).
    private func armLaunchWatchdog(command: String, runId: String) {
        launchWatchdog?.cancel()
        // Monotonic, like Task.sleep: a wall-clock step (NTP) can neither end the wait early
        // nor make it read as not yet due and exit, leaving "Launching workflow…" up for good.
        let clock = ContinuousClock()
        let started = clock.now
        launchWatchdog = Task { @MainActor [weak self] in
            var wait = LaunchWatchdog.timeout
            while true {
                try? await Task.sleep(for: .seconds(wait), clock: clock)
                guard !Task.isCancelled, let self, self.activeRunId == runId else { return }
                let live = self.store?.run(id: runId)?.isLive == true && self.activeRunWentLive
                let elapsed = LaunchWatchdog.seconds(clock.now - started)
                switch LaunchWatchdog.verdict(elapsed: elapsed, replied: self.launchReplied, runWentLive: live, command: command) {
                case .timedOut(let message):
                    self.errorMessage = message
                    self.status = "Could not launch"
                    self.finishActiveProcess()
                    self.activeRunId = nil
                    self.refresh()
                    return
                case .done:
                    return
                case .keepWaiting:
                    // Woke early: wait out the rest instead of giving up silently.
                    wait = LaunchWatchdog.remaining(elapsed: elapsed)
                }
            }
        }
    }

    /// A run left "running" with no live Pi behind it (the app quit, a script ended) can only be
    /// resumed, never finished on its own. Called on attach. Runs launched by scripts are not this
    /// process's children, so this asks whether the Pi that owns the run is still alive.
    func markOrphanedRuns() {
        guard let store else { return }
        let now = Date()
        for run in store.runs() where run.isLive && run.id != activeRunId {
            let lastEvent = store.events(runId: run.id).last.flatMap { RunLiveness.parseISO($0.at) }
            if RunLiveness.isOrphaned(run: run, lastEventAt: lastEvent, now: now, pidAlive: RunLiveness.processAlive) {
                store.markOrphaned(runId: run.id, message: "No live Pi process behind this run (found at launch). Resume to finish it.")
            }
        }
    }

    func stop() {
        if let activeRunId, process?.isRunning == true {
            send(["type": "prompt", "message": "/orchestrator stop {\"runId\":\"\(activeRunId)\"}"])
            // Pi is ended on the next line, before it can act on the stop command, so the
            // app itself marks the run stopped and cancels its waiting gates. Otherwise a
            // stopped run kept a pending gate card nobody could ever answer.
            store?.markStoppedByUser(runId: activeRunId)
        }
        finishActiveProcess()
        activeRunId = nil
        isRunning = false
        refresh()
    }

    private func finishActiveProcess() {
        launchWatchdog?.cancel()
        launchWatchdog = nil
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        if let process, process.isRunning {
            ProcessTree.terminate(pid: process.processIdentifier)
            process.terminate()
        }
        process = nil
        inputPipe = nil
        outputPipe = nil
        isRunning = false
    }


    // MARK: Attorney decisions

    func decide(checkpoint: CheckpointRecord, approved: Bool, comment: String) {
        let decision = Self.decision(approved: approved, comment: comment)
        store?.decide(checkpointId: checkpoint.id, status: decision.status, comment: decision.comment)
        refresh()
    }

    /// What a decision stores. The comment is the attorney's note exactly as typed
    /// (trimmed), because the next step receives it verbatim: in cross-exam it is the
    /// witness's answer. The approval is recorded only in `status`; nothing like
    /// "Approved by attorney." is ever added to the text.
    nonisolated static func decision(approved: Bool, comment: String) -> (status: String, comment: String) {
        (approved ? "approved" : "changes_requested", comment.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    func overrideStep(runId: String, stepIndex: Int, text: String, note: String?) {
        store?.setStepOverride(runId: runId, stepIndex: stepIndex, text: text, note: note)
        refresh()
    }

    func clearOverride(runId: String, stepIndex: Int) {
        store?.clearStepOverride(runId: runId, stepIndex: stepIndex)
        refresh()
    }

    func reopenReview(runId: String) {
        store?.reopenFinalReview(runId: runId)
        refresh()
    }

    func deleteRun(_ run: RunRecord) {
        if run.id == activeRunId { stop() }
        // Collect the session files before the journal that names them is deleted.
        let files = store?.sessionFiles(runId: run.id) ?? []
        if store?.deleteRun(id: run.id) == true { SessionFiles.remove(files) }
        if selectedRunId == run.id { selectedRunId = nil }
        refresh()
    }

    // MARK: RPC plumbing

    private func send(_ command: [String: Any]) {
        guard let inputPipe, JSONSerialization.isValidJSONObject(command) else { return }
        do {
            var data = try JSONSerialization.data(withJSONObject: command)
            data.append(0x0A)
            try inputPipe.fileHandleForWriting.write(contentsOf: data)
        } catch {
            errorMessage = "Could not send the request to Pi: \(error.localizedDescription)"
        }
    }

    private nonisolated func consume(_ data: Data) {
        let lines = lineBuffer.append(data)
        for line in lines {
            Task { @MainActor in self.handle(line: line) }
        }
    }

    private func handle(line: Data) {
        guard let event = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let type = event["type"] as? String else { return }
        switch type {
        case "message_start":
            guard let message = event["message"] as? [String: Any],
                  message["customType"] as? String == "orchestrator:reply",
                  let content = message["content"] as? String,
                  let reply = try? JSONSerialization.jsonObject(with: Data(content.utf8)) as? [String: Any] else { return }
            if ["start", "resume"].contains(reply["op"] as? String ?? "") {
                launchReplied = true
                launchWatchdog?.cancel()
                launchWatchdog = nil
            }
            if reply["ok"] as? Bool == true {
                status = reply["op"] as? String == "resume" ? "Workflow resumed" : "Workflow running"
                if let warnings = reply["warnings"] as? [String], !warnings.isEmpty {
                    errorMessage = "Pi warnings: " + warnings.joined(separator: " · ")
                }
            } else {
                let message = reply["error"] as? String ?? "The workflow could not be started."
                errorMessage = message
                status = "Failed"
                finishActiveProcess()
                activeRunId = nil
            }
            refresh()
        case "extension_error":
            let detail = (event["error"] as? String) ?? (event["message"] as? String)
            errorMessage = detail.map { "Pi extension error: \($0)" } ?? "Pi extension error."
        case "extension_ui_request":
            if event["method"] as? String == "notify",
               event["notifyType"] as? String == "error",
               let message = event["message"] as? String {
                errorMessage = message
            }
        default:
            break
        }
    }

    private final class LineBuffer: @unchecked Sendable {
        private var data = Data()
        private let lock = NSLock()

        func append(_ incoming: Data) -> [Data] {
            lock.lock()
            defer { lock.unlock() }
            data.append(incoming)
            var lines: [Data] = []
            while let newline = data.firstIndex(of: 0x0A) {
                lines.append(Data(data[..<newline]))
                data.removeSubrange(...newline)
            }
            return lines
        }
    }
}

/// Ends a Pi process and everything it started. Pi's delegated agents are its
/// children, and they start processes of their own; killing only Pi's direct
/// children (the old `pkill -P`) left those grandchildren running. Foundation's
/// `Process` starts Pi as the leader of its own process group, so signalling the
/// group reaches every descendant that did not leave it; direct children that did
/// are signalled as before.
enum ProcessTree {
    /// Whether `pid` leads a process group of its own that is not the app's
    /// (signalling the app's own group would end the app).
    nonisolated static func ownsGroup(pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        let group = getpgid(pid)
        return group == pid && group != getpgrp()
    }

    nonisolated static func terminate(pid: Int32, signal: Int32 = SIGTERM) {
        guard pid > 0 else { return }
        // The group first, while Pi is certainly alive: once its children die it may
        // exit and be reaped, and then its group can no longer be looked up.
        if ownsGroup(pid: pid) { killpg(pid, signal) }
        let killer = Process()
        killer.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        killer.arguments = ["-\(signal)", "-P", String(pid)]
        try? killer.run()
        killer.waitUntilExit()
    }
}
