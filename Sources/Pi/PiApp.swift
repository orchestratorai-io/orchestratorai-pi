import AppKit
import Foundation
import SwiftUI
import Textual
import UniformTypeIdentifiers

struct AttorneyReviewItem: Identifiable, Hashable {
    let id: String
    let text: String
    let severity: String?
    /// The report already had it ticked (`- [x]`).
    var checkedInReport = false

    /// Which items show as reviewed: the attorney's saved tick or untick
    /// (`review_checks`) where there is one, otherwise what the report said.
    static func reviewedIDs(_ items: [AttorneyReviewItem], saved: [String: Bool]) -> Set<String> {
        Set(items.filter { saved[$0.id] ?? $0.checkedInReport }.map(\.id))
    }
}

/// What the launch card's source box shows for the chosen file or folder.
enum SourcePreview: Equatable {
    case text(String)
    /// A folder's visible entries, sorted, subfolders ending in "/"; `more` counts those not listed.
    case folder(entries: [String], more: Int)
    case unreadable

    static func load(_ url: URL, maxEntries: Int = 200) -> SourcePreview {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue {
            let urls = (try? FileManager.default.contentsOfDirectory(
                at: url, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]
            )) ?? []
            let names = urls.map { entry in
                let folder = (try? entry.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
                return entry.lastPathComponent + (folder ? "/" : "")
            }
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
            return .folder(entries: Array(names.prefix(maxEntries)), more: max(0, names.count - maxEntries))
        }
        if let text = try? String(contentsOf: url, encoding: .utf8) { return .text(text) }
        return .unreadable
    }
}

@main
struct PiApp: App {
    var body: some Scene {
        WindowGroup("Pi - OrchestratorAI Legal") {
            ContentView()
                .frame(minWidth: 960, idealWidth: 1500, minHeight: 720, idealHeight: 1150)
        }
        .windowResizability(.contentMinSize)
    }
}

struct ContentView: View {
    /// The "Local model" box's starting value. Matt chose qwen3.6:35b-mlx on
    /// 2026-11-23 because qwen3.6:latest is no longer installed on the Studio
    /// (docs/matt-queue-archive.md).
    static let defaultModel = "qwen3.6:35b-mlx"

    @StateObject private var runner = PiRunner()
    @State private var selectedFile: URL?
    @State private var showingImporter = false
    @State private var paramValues: [String: String] = [:]
    @State private var model = ContentView.defaultModel
    @State private var selectedWorkflow = "contract-review"
    @State private var showingActivity = false
    @State private var reviewDecisionComment = ""
    @State private var gateDecisionComment = ""
    @State private var runPendingDeletion: RunRecord?
    @State private var showingDeleteConfirmation = false
    @State private var runsPendingClear: [RunRecord] = []
    @State private var showingClearApprovedConfirmation = false
    @State private var sidebarSelection: SidebarSelection? = .workflow("contract-review")
    @State private var expandedGroups: Set<String> = Set(LegalWorkflowCatalog.groups.map(\.id))
    @State private var projectDirectory = PiEnvironment.findProjectDirectory()
    @State private var projectTrusted = false
    @State private var workflows: [WorkflowDefinition] = []

    private var activeWorkflow: WorkflowDefinition? {
        DetailSelection.activeWorkflow(selected: selectedWorkflow, openRun: runner.selectedRun, in: workflows)
    }

    /// The run shown in the detail pane: the selected run when it belongs to the selected
    /// workflow, including a run whose workflow has no catalog entry (an `inline` TUI run).
    private var displayedRun: RunRecord? {
        DetailSelection.displayedRun(runner.selectedRun, selectedWorkflow: selectedWorkflow, activeWorkflow: activeWorkflow)
    }

    private var displayedState: ReviewState? {
        displayedRun.map { runner.reviewState(for: $0) }
    }

    var body: some View {
        NavigationSplitView {
            SidebarView(
                runner: runner,
                workflows: workflows,
                selection: $sidebarSelection,
                expandedGroups: $expandedGroups
            )
        } content: {
            RunListView(
                runner: runner,
                selection: sidebarSelection,
                workflow: sidebarSelection?.workflowId.flatMap { id in workflows.first(where: { $0.id == id }) },
                onOpen: openRun,
                onNewRun: startNewRun,
                onDelete: { run in
                    runPendingDeletion = run
                    showingDeleteConfirmation = true
                },
                onClearApproved: { runs in
                    guard !runs.isEmpty else { return }
                    runsPendingClear = runs
                    showingClearApprovedConfirmation = true
                }
            )
        } detail: {
            if sidebarSelection == .inbox, runner.selectedRun == nil {
                inboxPlaceholder
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    header

                    ScrollView {
                        VStack(alignment: .leading, spacing: 22) {
                            if !projectTrusted { trustCard }
                            if runner.storeUnavailable { storeCard }
                            taskCard
                            if activeWorkflow?.isReady == true || displayedRun != nil {
                                contextCard
                                sourceDocumentCard
                                gateCard
                                attorneyReviewCard
                                resultCard
                                resumeCard
                                EvaluationsCard(evaluations: runner.evaluations)
                                humanReviewCard
                            }
                        }
                        .padding(28)
                    }
                }
                .frame(minWidth: 400)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            reloadProject()
            runner.attach(projectDirectory: projectDirectory)
            if let run = runner.selectedRun {
                selectedWorkflow = run.workflow
                // attach() opened the newest run; fill its model as openRun does, or Resume on it
                // would quietly switch to the default model.
                model = ResumeModel.boxValue(opening: run, current: model)
            } else if let firstReady = workflows.first(where: \.isReady) {
                selectedWorkflow = firstReady.id
            }
            // A run whose workflow has no catalog row (an `inline` TUI run) opens under Inbox.
            sidebarSelection = workflows.contains(where: { $0.id == selectedWorkflow }) ? .workflow(selectedWorkflow) : .inbox
            resetParams()
        }
        .onChange(of: sidebarSelection) { _, newValue in
            // Inbox keeps whatever run is open; a catalog row switches the active workflow.
            if case .workflow(let id) = newValue {
                selectedWorkflow = id
            }
        }
        .onChange(of: selectedWorkflow) { _, _ in
            // Switching into the run that is already open (openRun sets the workflow, then this
            // fires later) keeps the params openRun filled in from the run; anything else is a
            // fresh launch card for the new workflow.
            guard !DetailSelection.isOpening(runner.selectedRun, workflow: selectedWorkflow) else { return }
            reviewDecisionComment = ""
            gateDecisionComment = ""
            selectedFile = nil
            runner.select(runId: nil)
            resetParams()
        }
        .fileImporter(
            isPresented: $showingImporter,
            allowedContentTypes: activeWorkflow?.launch?.inputKind == .folder ? [.folder] : [.item, .data, .text, .pdf],
            allowsMultipleSelection: false
        ) { result in
            if case .success(let urls) = result {
                selectedFile = urls.first
            }
        }
        .alert("OrchestratorAI - Pi", isPresented: Binding(
            get: { runner.errorMessage != nil },
            set: { if !$0 { runner.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { runner.errorMessage = nil }
        } message: {
            Text(runner.errorMessage ?? "Unknown error")
        }
        .alert("Delete this run?", isPresented: $showingDeleteConfirmation) {
            Button("Delete Run", role: .destructive) {
                if let run = runPendingDeletion { runner.deleteRun(run) }
                runPendingDeletion = nil
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This permanently removes the run and everything stored with it on this Mac: its journal, attorney checkpoints, edits, live agent text and agent session files.\n\n\(runPendingDeletion?.title ?? "This run")")
        }
        .alert("Clear approved runs?", isPresented: $showingClearApprovedConfirmation) {
            Button("Delete \(runsPendingClear.count) Approved", role: .destructive) {
                for run in runsPendingClear { runner.deleteRun(run) }
                runsPendingClear = []
            }
            Button("Cancel", role: .cancel) { runsPendingClear = [] }
        } message: {
            Text("This permanently removes \(runsPendingClear.count) approved run\(runsPendingClear.count == 1 ? "" : "s") in this list, and everything stored with them on this Mac (journals, attorney checkpoints, edits, live agent text and agent session files).")
        }
    }

    private func reloadProject() {
        projectDirectory = PiEnvironment.findProjectDirectory()
        let seenGroups = Set(workflows.map(\.groupId))
        workflows = LegalWorkflowCatalog.workflows(projectDirectory: projectDirectory)
        // A group only a user's own workflow names starts expanded, like Legal's five.
        expandedGroups.formUnion(Set(workflows.map(\.groupId)).subtracting(seenGroups).subtracting(LegalWorkflowCatalog.groups.map(\.id)))
        projectTrusted = PiEnvironment.isProjectTrusted(projectDirectory)
    }

    /// The launch fields for the active workflow; while a run is open, its saved params.
    private func resetParams() {
        paramValues = activeWorkflow?.launch?.values(opening: displayedRun) ?? displayedRun?.params ?? [:]
    }

    // MARK: Selection

    /// Inbox with nothing open: the detail has no workflow to frame, so say so.
    private var inboxPlaceholder: some View {
        VStack(spacing: 10) {
            Image(systemName: "tray")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("Select a run")
                .font(.headline)
            Text("Pick a run from the list to review it, or choose a workflow in the sidebar to start a new one.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(28)
        .frame(minWidth: 400)
    }

    /// "New run" in the list: drop the open run so the detail shows the bare launch card.
    private func startNewRun() {
        reviewDecisionComment = ""
        gateDecisionComment = ""
        selectedFile = nil
        runner.select(runId: nil)
        resetParams()
    }

    private func openRun(_ run: RunRecord) {
        reviewDecisionComment = ""
        gateDecisionComment = ""
        selectedWorkflow = run.workflow
        runner.select(runId: run.id)
        if let source = run.sourceDocument, source.hasPrefix("/") {
            selectedFile = URL(fileURLWithPath: source)
        } else {
            selectedFile = nil
        }
        // The run's saved params over the defaults of its own workflow (not the one shown before).
        resetParams()
        // Show the run's own model, so Resume runs on it unless the attorney types another.
        model = ResumeModel.boxValue(opening: run, current: model)
    }

    // MARK: Header and setup cards

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "scalemass.fill")
                .font(.title2)
                .foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 2) {
                Text("Pi - try OrchestratorAI Legal on your Mac")
                    .font(.title2.weight(.semibold))
                Text(activeWorkflow?.title ?? displayedRun?.workflow ?? "Workflows")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Circle()
                .fill(runner.isRunning || (displayedState?.isLive ?? false) ? .orange : .green)
                .frame(width: 9, height: 9)
            Text(displayedState?.label ?? runner.status)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let run = displayedRun {
                Text("· \(run.title)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 18)
        .background(.regularMaterial)
    }

    private var trustCard: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                Label("Allow Pi to run workflows from this folder", systemImage: "lock.shield")
                    .font(.headline)
                Text("Pi is a free way to try the OrchestratorAI Legal workflows on this Mac. They use the legal agents, skills and attorney review steps stored in this folder. Pi needs your permission once before it will load them. Until you allow it, no workflow can start.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text(projectDirectory.path)
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
                Button("Allow Pi to use this folder") {
                    do {
                        try PiEnvironment.trustProject(projectDirectory)
                        projectTrusted = true
                    } catch {
                        runner.errorMessage = "Could not save the trust decision: \(error.localizedDescription)"
                    }
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("trust.approve")
            }
            .padding(8)
        }
    }

    private var storeCard: some View {
        GroupBox {
            Label("Could not open data/orchestrator.sqlite in \(projectDirectory.path)", systemImage: "externaldrive.badge.xmark")
                .font(.callout)
                .foregroundStyle(.red)
                .padding(8)
        }
    }

    // MARK: Launch

    private var taskCard: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 16) {
                if let workflow = activeWorkflow {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                Text(workflow.title)
                                    .font(.title3.weight(.semibold))
                                Text(workflow.status.label)
                                    .font(.caption.weight(.semibold))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(workflow.isReady ? Color.green.opacity(0.18) : Color.secondary.opacity(0.14))
                                    .foregroundStyle(workflow.isReady ? Color.green : Color.secondary)
                                    .clipShape(Capsule())
                            }
                            Text(workflow.description)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: workflow.icon)
                            .font(.largeTitle)
                            .foregroundStyle(.blue.opacity(0.75))
                    }

                    if let launch = workflow.launch {
                        launchControls(workflow: workflow, launch: launch)
                    } else {
                        notInstalled(workflow: workflow)
                    }
                } else if let run = displayedRun {
                    Label("Workflow \u{201C}\(run.workflow)\u{201D}", systemImage: "doc.text")
                        .font(.title3.weight(.semibold))
                    Text("This run's workflow is not in this Mac's workflow list (runs started in the Pi terminal are recorded as \u{201C}inline\u{201D}). You can review the run here, but a new one cannot be started from this card.")
                        .foregroundStyle(.secondary)
                } else {
                    Text("No workflows found in \(projectDirectory.appendingPathComponent(".pi/workflows").path)")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(8)
        }
    }

    /// Start is allowed once the input the launch block asks for is present and every required field is filled.
    private func canStart(_ launch: WorkflowLaunchSpec) -> Bool {
        launch.canStart(hasInput: selectedFile != nil, values: paramValues)
    }

    @ViewBuilder
    private func launchControls(workflow: WorkflowDefinition, launch: WorkflowLaunchSpec) -> some View {
        if launch.inputKind != .none {
            Button {
                showingImporter = true
            } label: {
                Label(
                    selectedFile == nil ? "Choose a \(launch.fileLabel)" : "Choose a different \(launch.fileLabel)",
                    systemImage: launch.inputKind == .folder ? "folder.badge.plus" : "folder"
                )
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("launch.choose_file")
        } else {
            Text("No document upload — fill in the fields below, then start.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }

        if let selectedFile, launch.inputKind != .none {
            Label(selectedFile.path, systemImage: "doc")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }

        if !launch.samples.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Demo samples")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                // Samples come from the workflow's own launch block — not a per-workflow screen.
                ForEach(launch.samples) { sample in
                    let url = projectDirectory.appendingPathComponent(sample.relativePath)
                    let exists = FileManager.default.fileExists(atPath: url.path)
                    Button {
                        guard exists else {
                            runner.errorMessage = "Demo sample missing: \(sample.relativePath)"
                            return
                        }
                        selectedFile = url
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: selectedFile?.path == url.path ? "checkmark.circle.fill" : "doc.text")
                            Text(sample.title)
                            Spacer(minLength: 0)
                            if !exists {
                                Text("missing")
                                    .font(.caption2)
                                    .foregroundStyle(.red)
                            }
                        }
                        .font(.caption)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.bordered)
                    .disabled(!exists)
                    .accessibilityIdentifier("launch.sample.\(sample.id)")
                }
            }
        }

        HStack {
            Button {
                startRun(workflow: workflow, launch: launch)
            } label: {
                Label(runner.isRunning ? "Working…" : "Start local workflow", systemImage: "play.fill")
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canStart(launch) || runner.isRunning || !projectTrusted)
            .accessibilityIdentifier("launch.start")

            if runner.isRunning {
                Button("Stop", role: .destructive) {
                    runner.stop()
                }
                .accessibilityIdentifier("launch.stop")
            }
        }
    }

    private func notInstalled(workflow: WorkflowDefinition) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Not installed yet", systemImage: "hourglass")
                .font(.subheadline.weight(.semibold))
            Text("No `.pi/workflows/\(workflow.id).yaml` in this project. Add the workflow YAML with an `orchestrator-launch` block in its `doc:` and it appears here with its own launch UI — no app change needed.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Button {
                // Intentionally disabled — do not fake a run.
            } label: {
                Label("Start local workflow", systemImage: "play.fill")
            }
            .buttonStyle(.borderedProminent)
            .disabled(true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var contextCard: some View {
        Group {
            if let launch = activeWorkflow?.launch {
                GroupBox("Workflow context") {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(launch.fields) { field in
                            HStack(alignment: field.kind == .text ? .top : .center) {
                                Text(field.label)
                                    .frame(width: 90, alignment: .leading)
                                switch field.kind {
                                case .choice:
                                    Picker(field.label, selection: binding(for: field.param)) {
                                        ForEach(field.options, id: \.self) { Text($0).tag($0) }
                                    }
                                    .labelsHidden()
                                    .accessibilityIdentifier("context.field.\(field.param)")
                                case .line:
                                    TextField(field.label, text: binding(for: field.param))
                                        .textFieldStyle(.roundedBorder)
                                        .accessibilityIdentifier("context.field.\(field.param)")
                                case .text:
                                    TextEditor(text: binding(for: field.param))
                                        .font(.body)
                                        .frame(minHeight: 68)
                                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                                        .accessibilityIdentifier("context.field.\(field.param)")
                                }
                            }
                        }

                        HStack {
                            Text("Local model")
                                .frame(width: 90, alignment: .leading)
                            TextField("Ollama model", text: $model)
                                .textFieldStyle(.roundedBorder)
                                .accessibilityIdentifier("context.model")
                            Text("Ollama")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(8)
                }
            }
        }
    }

    private func binding(for param: String) -> Binding<String> {
        Binding(
            get: { paramValues[param] ?? "" },
            set: { paramValues[param] = $0 }
        )
    }

    /// A run of a typed workflow is titled after its first field, which for
    /// `legal-research` or `kb-query` is a whole question. Eighty characters of it
    /// needs around 650pt to draw — wider than the runs column at any laptop size,
    /// so the run list showed a sentence cut mid-word. Keep enough to tell two runs
    /// apart, and end on a word.
    static func runTitleFragment(_ text: String, limit: Int = 48) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > limit else { return trimmed }
        let head = trimmed.prefix(limit)
        let cut = head.lastIndex(of: " ").map { head[..<$0] } ?? head
        return cut.trimmingCharacters(in: .whitespaces) + "…"
    }

    private func startRun(workflow: WorkflowDefinition, launch: WorkflowLaunchSpec) {
        var params = paramValues
        params.removeValue(forKey: "run_id")
        let source: String
        if launch.inputKind == .none {
            // Title the run after the first required field (e.g. the research question).
            let key = launch.fields.first(where: { launch.requiredFieldParams.contains($0.param) })?.param ?? launch.fields.first?.param ?? ""
            source = Self.runTitleFragment(paramValues[key] ?? workflow.title)
        } else {
            guard let selectedFile else { return }
            params[launch.fileParam] = selectedFile.path
            source = selectedFile.path
        }
        reviewDecisionComment = ""
        gateDecisionComment = ""
        runner.start(workflow: workflow, params: params, sourceDocument: source, model: model)
    }

    // MARK: Resume (crash recovery + edit-before-resume)

    private var resumeCard: some View {
        Group {
            if let run = displayedRun, let state = displayedState, state == .failed || state == .stopped, !runner.isRunning {
                StepOutputsCard(
                    run: run,
                    steps: runner.stepOutputs,
                    onResume: { runner.resume(run: run, model: model, fallbackModel: ContentView.defaultModel) },
                    onOverride: { index, text in runner.overrideStep(runId: run.id, stepIndex: index, text: text, note: nil) },
                    onClearOverride: { index in runner.clearOverride(runId: run.id, stepIndex: index) }
                )
            }
        }
    }

    // MARK: Gate (mid-flow attorney decision)

    private var gateCard: some View {
        Group {
            if let run = displayedRun, case .awaitingGate(let gate) = runner.reviewState(for: run) {
                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Label(gate.title, systemImage: "hand.raised.fill")
                                .font(.headline)
                            Spacer()
                            Text("Workflow paused")
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(Color.orange.opacity(0.18))
                                .foregroundStyle(.orange)
                                .clipShape(Capsule())
                        }
                        Text("An agent is waiting on your direction before the workflow continues. Your decision and note are handed back to the next step verbatim.")
                            .font(.callout)
                            .foregroundStyle(.secondary)

                        if let summary = gate.summaryMarkdown, !summary.isEmpty {
                            ScrollView {
                                StructuredText(markdown: summary)
                                    .textual.structuredTextStyle(.gitHub)
                                    .textual.textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(14)
                            }
                            .frame(minHeight: 160, maxHeight: 360)
                            .background(Color(nsColor: .textBackgroundColor))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }

                        TextField("Direction for the next step (optional)…", text: $gateDecisionComment)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("gate.comment")

                        HStack {
                            Button("Approve and continue") {
                                runner.decide(checkpoint: gate, approved: true, comment: gateDecisionComment)
                                gateDecisionComment = ""
                            }
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("gate.approve")
                            Button("Request changes and continue") {
                                runner.decide(checkpoint: gate, approved: false, comment: gateDecisionComment)
                                gateDecisionComment = ""
                            }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("gate.request_changes")
                        }
                    }
                    .padding(8)
                }
            }
        }
    }

    // MARK: Report

    private var finalMarkdown: String {
        displayedRun?.resultMarkdown?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private var attorneyReviewItems: [AttorneyReviewItem] {
        Self.parseAttorneyItems(from: finalMarkdown)
    }


    private var resultCard: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Final report")
                        .font(.headline)
                    Spacer()
                    Button {
                        saveReport()
                    } label: {
                        Label("Save Markdown", systemImage: "square.and.arrow.down")
                    }
                    .buttonStyle(.borderless)
                    .disabled(finalMarkdown.isEmpty)
                    .accessibilityIdentifier("report.save")
                }

                if let run = displayedRun, let state = displayedState {
                    if state == .failed || state == .stopped, finalMarkdown.isEmpty {
                        VStack(spacing: 10) {
                            Image(systemName: "xmark.octagon")
                                .font(.largeTitle)
                                .foregroundStyle(.red)
                            Text(state == .failed ? "Workflow failed" : "Workflow stopped")
                                .font(.headline)
                            Text(run.error ?? "The local workflow stopped without a final report. Check Activity for the failing step, fix the input or model, and re-run. No alternate workflow was launched.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity, minHeight: 220)
                        .padding(.horizontal, 12)
                    } else if finalMarkdown.isEmpty {
                        VStack(spacing: 10) {
                            ProgressView()
                            Text(state.label)
                                .font(.headline)
                            Text(runner.events.last?.summary ?? "Waiting for the first agent…")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                            // Live text: what each running agent is writing, streamed by the child process itself.
                            ForEach(runner.liveText) { live in
                                VStack(alignment: .leading, spacing: 4) {
                                    Label(live.label, systemImage: "text.cursor")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                    ScrollView {
                                        Text(live.text.isEmpty ? "…" : live.text)
                                            .font(.caption.monospaced())
                                            .textSelection(.enabled)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .padding(8)
                                    }
                                    .frame(maxHeight: 180)
                                    .background(Color(nsColor: .textBackgroundColor))
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .accessibilityIdentifier("live.\(live.label)")
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: 220)
                        .padding(.horizontal, 12)
                    } else {
                        ScrollView {
                            StructuredText(markdown: finalMarkdown)
                                .textual.structuredTextStyle(.gitHub)
                                .textual.textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(14)
                        }
                        .frame(minHeight: 260, maxHeight: 430)
                        .background(Color(nsColor: .textBackgroundColor))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    activitySection
                } else {
                    VStack(spacing: 10) {
                        Image(systemName: "doc.text.magnifyingglass")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                        Text("No report yet")
                            .font(.headline)
                        Text("Choose a \(activeWorkflow?.fileLabel ?? "document") (or a demo sample), set context, and start the local workflow. Results and the attorney checklist appear here.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity, minHeight: 220)
                    .padding(.horizontal, 12)
                }
            }
            .padding(8)
        }
    }

    private var attorneyReviewCard: some View {
        let items = attorneyReviewItems
        // Ticks are saved in the store per run, so they survive opening another run or quitting.
        let reviewedIssueIDs = AttorneyReviewItem.reviewedIDs(items, saved: runner.reviewChecks)
        let reviewedCount = reviewedIssueIDs.count
        let copy = activeWorkflow?.launch?.review ?? LaunchReviewCopy()
        return GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    Label(copy.focusTitle, systemImage: "exclamationmark.bubble")
                        .font(.headline)
                    Spacer()
                    if !items.isEmpty {
                        Text("\(reviewedCount)/\(items.count) marked reviewed")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Text(copy.focusSubtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if let state = displayedState, state.isLive {
                    Label("Workflow running — checklist appears when the report is ready.", systemImage: "hourglass")
                        .font(.caption)
                        .foregroundStyle(.orange)
                } else if displayedState == .failed || displayedState == .stopped {
                    Label("No checklist — the workflow ended before a report was produced.", systemImage: "xmark.octagon")
                        .font(.caption)
                        .foregroundStyle(.red)
                } else if finalMarkdown.isEmpty {
                    Text("After you run a Ready workflow, prioritized issues for counsel appear here as a shared checklist (same HITL path for every workflow).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if items.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Report has no attorney-review checklist", systemImage: "questionmark.circle")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.orange)
                        Text("Expected unchecked items under “Attorney review focus” (`- [ ] SEVERITY — issue; action`). Open the final report below, or re-run if the model omitted the section.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    ProgressView(value: Double(reviewedCount), total: Double(max(items.count, 1)))
                        .tint(reviewedCount == items.count ? .green : .orange)
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(items) { item in
                            Button {
                                if let run = displayedRun {
                                    runner.setReviewed(runId: run.id, itemId: item.id, reviewed: !reviewedIssueIDs.contains(item.id))
                                }
                            } label: {
                                HStack(alignment: .top, spacing: 8) {
                                    Image(systemName: reviewedIssueIDs.contains(item.id) ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(reviewedIssueIDs.contains(item.id) ? .green : .orange)
                                    if let severity = item.severity {
                                        Text(severity)
                                            .font(.caption2.weight(.bold))
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .background(severityTint(severity).opacity(0.18))
                                            .foregroundStyle(severityTint(severity))
                                            .clipShape(Capsule())
                                    }
                                    Text(item.text)
                                        .font(.callout)
                                        .foregroundStyle(.primary)
                                        .multilineTextAlignment(.leading)
                                        .strikethrough(reviewedIssueIDs.contains(item.id), color: .secondary)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(8)
        }
    }

    private func severityTint(_ severity: String) -> Color {
        switch severity.uppercased() {
        case "HIGH", "CRITICAL": return .red
        case "MEDIUM": return .orange
        case "LOW": return .blue
        default: return .secondary
        }
    }

    private var humanReviewCard: some View {
        let items = attorneyReviewItems
        // Ticks are saved in the store per run, so they survive opening another run or quitting.
        let reviewedIssueIDs = AttorneyReviewItem.reviewedIDs(items, saved: runner.reviewChecks)
        let reviewedCount = reviewedIssueIDs.count
        let allReviewed = items.isEmpty || reviewedCount == items.count
        let copy = activeWorkflow?.launch?.review ?? LaunchReviewCopy()

        return Group {
            if let run = displayedRun, let state = displayedState {
                let pendingFinal = runner.checkpoints(for: run.id).last(where: { $0.kind == "final_review" && $0.isPending })
                if let pendingFinal {
                    GroupBox {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Label("Attorney review required", systemImage: "person.badge.key")
                                    .font(.headline)
                                Spacer()
                                Text("HITL checkpoint")
                                    .font(.caption2.weight(.semibold))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(Color.orange.opacity(0.18))
                                    .foregroundStyle(.orange)
                                    .clipShape(Capsule())
                            }

                            Text(copy.blurb)
                                .font(.callout)
                                .foregroundStyle(.secondary)

                            if !items.isEmpty {
                                HStack(spacing: 8) {
                                    Image(systemName: allReviewed ? "checkmark.seal.fill" : "circle.dashed")
                                        .foregroundStyle(allReviewed ? .green : .orange)
                                    Text(allReviewed
                                         ? "All \(items.count) focus items marked reviewed."
                                         : "\(reviewedCount) of \(items.count) focus items marked reviewed — finish the checklist above before approving when possible.")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            } else {
                                Text("No checklist items were parsed from the report. You can still approve or request changes after reading the full report.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }

                            VStack(alignment: .leading, spacing: 4) {
                                Text("Decision note (saved to checkpoint)")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                TextField("Optional note for the matter file…", text: $reviewDecisionComment)
                                    .textFieldStyle(.roundedBorder)
                                    .accessibilityIdentifier("review.comment")
                            }

                            HStack {
                                Button("Approve review") {
                                    runner.decide(checkpoint: pendingFinal, approved: true, comment: reviewDecisionComment)
                                    reviewDecisionComment = ""
                                }
                                .buttonStyle(.borderedProminent)
                                .accessibilityIdentifier("review.approve")

                                Button("Request changes") {
                                    runner.decide(checkpoint: pendingFinal, approved: false, comment: reviewDecisionComment)
                                    reviewDecisionComment = ""
                                }
                                .buttonStyle(.bordered)
                                .accessibilityIdentifier("review.request_changes")
                            }

                            if !allReviewed && !items.isEmpty {
                                Text("Approve stays available so demos are not blocked — the progress cue above is guidance, not a hard gate.")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .padding(8)
                    }
                } else if FinalReviewControl.choose(state: state, checkpoints: runner.checkpoints(for: run.id)) == .start {
                    // Completed, but no final review is waiting (it was never written, or the
                    // last one was cancelled). Without this the run sat in Needs attention
                    // with nothing to press.
                    GroupBox {
                        VStack(alignment: .leading, spacing: 10) {
                            Label("Final review not started", systemImage: "person.badge.key")
                                .font(.headline)
                            Text("This run finished, but no attorney review was opened for it. Start one to approve the report or request changes.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                            Button("Start final review") {
                                runner.reopenReview(runId: run.id)
                            }
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("review.start")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                    }
                } else if state == .approved || state == .changesRequested {
                    GroupBox {
                        VStack(alignment: .leading, spacing: 10) {
                            Label(state == .approved ? "Approved by attorney" : "Changes requested — re-run when ready", systemImage: state == .approved ? "checkmark.seal.fill" : "arrow.uturn.backward.circle")
                                .font(.headline)
                            ForEach(runner.checkpoints(for: run.id).filter { !$0.isPending }) { checkpoint in
                                HStack(alignment: .top, spacing: 8) {
                                    Image(systemName: checkpoint.isTimedOut ? "clock.badge.exclamationmark" : checkpoint.isGate ? "hand.raised" : "person.badge.key")
                                        .foregroundStyle(checkpoint.isTimedOut ? .orange : .secondary)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("\(checkpoint.title) — \(checkpoint.statusLabel)")
                                            .font(.caption.weight(.semibold))
                                        if let comment = checkpoint.decisionComment, !comment.isEmpty {
                                            Text(comment)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                        Text(Self.displayDate(checkpoint.decidedAt ?? checkpoint.requestedAt))
                                            .font(.caption2)
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                            }
                            Button("Reopen for review") {
                                runner.reopenReview(runId: run.id)
                            }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("review.reopen")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                    }
                }
            }
        }
    }

    private var sourceDocumentCard: some View {
        Group {
            if activeWorkflow?.launch?.inputKind != LaunchInputKind.none {
                sourceDocumentBox
            }
        }
    }

    private var sourceDocumentBox: some View {
        GroupBox {
            DisclosureGroup {
                switch selectedFile.map({ SourcePreview.load($0) }) {
                case .text(let source):
                    ScrollView {
                        Text(source)
                            .font(.system(.body, design: .serif))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                    }
                    .frame(minHeight: 120, maxHeight: 300)
                    .background(Color(nsColor: .textBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                case .folder(let entries, let more):
                    ScrollView {
                        VStack(alignment: .leading, spacing: 3) {
                            if entries.isEmpty {
                                Text("This folder is empty.")
                                    .foregroundStyle(.secondary)
                            }
                            ForEach(entries, id: \.self) { name in
                                Label(name, systemImage: name.hasSuffix("/") ? "folder" : "doc")
                            }
                            if more > 0 {
                                Text("… and \(more) more")
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .font(.callout)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                    }
                    .frame(minHeight: 120, maxHeight: 300)
                    .background(Color(nsColor: .textBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                case .unreadable, nil:
                    Text(selectedFile == nil
                         ? "Choose a readable text or Markdown \(activeWorkflow?.fileLabel ?? "document") to preview it here."
                         : "This file could not be previewed as UTF-8 text (binary/PDF previews are not shown). The workflow can still use the path if the runtime supports it.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } label: {
                let isFolder = activeWorkflow?.launch?.inputKind == .folder
                let noun = isFolder ? "Source folder" : "Source document"
                Label(
                    selectedFile == nil ? noun : "\(noun) — \(selectedFile?.deletingPathExtension().lastPathComponent ?? "")",
                    systemImage: isFolder ? "folder" : "doc.plaintext"
                )
                .font(.headline)
            }
            .padding(8)
        }
    }

    private func saveReport() {
        guard !finalMarkdown.isEmpty, let run = displayedRun else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.plainText]
        panel.nameFieldStringValue = "\(run.title.replacingOccurrences(of: " — ", with: "-").replacingOccurrences(of: " ", with: "-"))-Report.md"
        let markdown = finalMarkdown
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                try markdown.write(to: url, atomically: true, encoding: .utf8)
            } catch {
                runner.errorMessage = "Could not save the report: \(error.localizedDescription)"
            }
        }
    }

    private var activitySection: some View {
        DisclosureGroup(isExpanded: $showingActivity) {
            VStack(alignment: .leading, spacing: 10) {
                if runner.events.isEmpty {
                    Text("No journal entries yet.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Workflow journal")
                        .font(.subheadline.weight(.semibold))
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(runner.events) { event in
                            DisclosureGroup {
                                if let detail = event.detail, !detail.isEmpty {
                                    Text(detail)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.vertical, 4)
                                }
                            } label: {
                                HStack(spacing: 8) {
                                    Text(Self.displayTime(event.at))
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.tertiary)
                                    Text(event.summary)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(event.isFailure ? .red : .secondary)
                                        .textSelection(.enabled)
                                }
                            }
                            .disclosureGroupStyle(.automatic)
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(nsColor: .controlBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                }
            }
            .padding(.top, 8)
        } label: {
            HStack {
                Label("Activity", systemImage: "clock.arrow.circlepath")
                Spacer()
                Text("\(runner.events.count) journal entries · \(displayedRun?.agents.map { "\($0) agent calls" } ?? "on-device store")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Parsing helpers

    /// The checklist under the report's "Attorney review focus" (or intake focus, or
    /// "Issues requiring attorney review") heading. Subheadings inside the section
    /// are part of it; the section ends at the next heading of the same or a higher
    /// level. `- [x]` items come through ticked.
    nonisolated static func parseAttorneyItems(from markdown: String) -> [AttorneyReviewItem] {
        var sectionLevel: Int?
        var items: [AttorneyReviewItem] = []
        for line in markdown.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let level = headingLevel(trimmed) {
                if trimmed.range(of: "^#{1,6}\\s+Attorney (review|intake) focus", options: [.regularExpression, .caseInsensitive]) != nil ||
                    trimmed.range(of: "^#{1,6}\\s+Issues requiring attorney review", options: [.regularExpression, .caseInsensitive]) != nil {
                    sectionLevel = level
                    continue
                }
                if let current = sectionLevel {
                    if level <= current { break }
                    continue
                }
            }
            guard sectionLevel != nil,
                  let box = trimmed.range(of: "^[-*] \\[[ xX]\\]\\s*", options: .regularExpression) else { continue }
            let checked = trimmed[box].contains { $0 == "x" || $0 == "X" }
            let value = String(trimmed[box.upperBound...])
            guard !value.isEmpty else { continue }
            let severity = parseSeverity(from: value)
            let display = stripSeverityPrefix(from: value)
            items.append(AttorneyReviewItem(id: "issue-\(items.count)-\(display)", text: display, severity: severity, checkedInReport: checked))
        }
        return items
    }

    /// 1–6 for a Markdown ATX heading (`## Title`), nil for anything else.
    nonisolated private static func headingLevel(_ line: String) -> Int? {
        guard let range = line.range(of: "^#{1,6}(\\s|$)", options: .regularExpression) else { return nil }
        return line[range].filter { $0 == "#" }.count
    }

    nonisolated private static func parseSeverity(from text: String) -> String? {
        let pattern = #"^\**(CRITICAL|HIGH|MEDIUM|LOW|INFO)\**\b"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              let swiftRange = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[swiftRange]).uppercased()
    }

    nonisolated private static func stripSeverityPrefix(from text: String) -> String {
        var result = text
        if parseSeverity(from: text) != nil,
           let range = result.range(of: #"^\**(CRITICAL|HIGH|MEDIUM|LOW|INFO)\**"#, options: [.regularExpression, .caseInsensitive]) {
            result.removeSubrange(range)
        }
        result = result.trimmingCharacters(in: .whitespaces)
        if result.hasPrefix("—") || result.hasPrefix("-") || result.hasPrefix(":") {
            result = String(result.dropFirst()).trimmingCharacters(in: .whitespaces)
        }
        return result.isEmpty ? text : result
    }

    static func displayDate(_ value: String) -> String {
        guard let date = parseDate(value) else { return value }
        let display = DateFormatter()
        display.dateStyle = .medium
        display.timeStyle = .short
        return display.string(from: date)
    }

    private static func displayTime(_ value: String) -> String {
        guard let date = parseDate(value) else { return value }
        let display = DateFormatter()
        display.dateFormat = "HH:mm:ss"
        return display.string(from: date)
    }

    private static func parseDate(_ value: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
